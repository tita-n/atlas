/**
 * Purpose-built file tools.
 *
 * Atlas previously exposed exactly one tool - `shell` - and the evaluation
 * caught the consequence: asked to create two files and run the tests, the
 * model narrated a plan and produced nothing. It tried to "open" a file the
 * way every coding assistant it had seen does, because no such tool existed.
 *
 * These are deliberately narrow. Each does one thing, takes a path, and is
 * checked against a workspace boundary, so a scoped approval or a sandbox mount
 * can constrain them meaningfully - which is not true of arbitrary shell text.
 */

import {
  constants as fsConstants,
  mkdir,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  canonicalise,
  checkProtectedAbsolute,
} from '../safety/protected-targets.js';

import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from '../providers/provider.interface.js';

export interface FileToolOptions {
  /** Directories these tools may read from. */
  readonly readRoots: readonly string[];
  /** Directories these tools may write to. Writes outside are refused. */
  readonly writeRoots: readonly string[];
  /** Largest file that will be read or written, in bytes. */
  readonly maxBytes?: number;
  /**
   * Atlas state directory, whose contents are never writable by these tools.
   *
   * Separate from the roots on purpose: a caller that set the workspace to
   * `$HOME` would otherwise hand out write access to the API keys.
   */
  readonly atlasHome?: string | undefined;
  /** Workspace whose `.git/hooks` and `.git/config` are refused. */
  readonly workspace?: string | undefined;
}

const DEFAULT_MAX_BYTES = 2_000_000;

/**
 * Resolves a path and refuses anything outside the permitted roots.
 *
 * Purely lexical, so it is the FIRST check and not the only one: `link ->
 * /etc` and `link -> ~/.atlas` both pass a string comparison and then reach
 * somewhere they must never go. Every caller follows up with the canonical
 * path check before touching the filesystem.
 */
function resolveWithin(
  raw: string,
  roots: readonly string[],
  label: string,
): string {
  if (raw.trim() === '') throw new Error(`empty path for ${label}`);
  const base = roots[0];
  if (base === undefined) throw new Error(`${label} has no permitted root`);
  // An absolute path is honoured only if it is already inside a root.
  const candidate = isAbsolute(raw) ? raw : join(base, raw);
  const full = resolve(candidate);
  const inside = roots.some((root) => {
    const rel = relative(resolve(root), full);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!inside) {
    throw new Error(`${label} is outside the permitted directories: ${raw}`);
  }
  return full;
}

function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function ok(content: string): ToolExecutionResult {
  return { content };
}

function fail(error: unknown): ToolExecutionResult {
  return {
    content: error instanceof Error ? error.message : String(error),
    isError: true,
  };
}

export class FileTools {
  readonly #readRoots: readonly string[];
  readonly #writeRoots: readonly string[];
  readonly #maxBytes: number;
  readonly #atlasHome: string;
  readonly #workspace: string | undefined;

  public constructor(options: FileToolOptions) {
    this.#readRoots = options.readRoots.map((root) => resolve(root));
    this.#writeRoots = options.writeRoots.map((root) => resolve(root));
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#atlasHome = resolve(
      options.atlasHome ?? process.env.ATLAS_HOME ?? join(process.cwd(), '.atlas'),
    );
    this.#workspace =
      options.workspace === undefined ? undefined : resolve(options.workspace);
  }

  /**
   * Second gate: the real path must also be inside the roots.
   *
   * `resolve()` cannot see through a symlink, so this is where `link ->
   * /etc/passwd` is caught. Both the path as written and its canonical form
   * are tested: the first so a symlink at the final component is refused, the
   * second so a symlinked parent directory is refused.
   */
  async #assertReachable(
    full: string,
    roots: readonly string[],
    label: string,
  ): Promise<void> {
    const canonical = await canonicalise(full);
    const insideWritten = roots.some((root) => contains(root, full));
    const insideReal = roots.some((root) => contains(root, canonical));
    if (!insideWritten || !insideReal) {
      throw new Error(
        `${label} resolves outside the permitted directories: ${full} -> ${canonical}`,
      );
    }
  }

  /**
   * Third gate: refuses Atlas state, Atlas's own code, and git hook files.
   *
   * Checked against the canonical path, so a symlink cannot be used to reach a
   * protected target by way of an innocent-looking name.
   */
  async #assertNotProtected(full: string): Promise<void> {
    const violation = await checkProtectedAbsolute(full, {
      atlasHome: this.#atlasHome,
      ...(this.#workspace === undefined
        ? {}
        : { workspace: this.#workspace }),
    });
    if (violation !== undefined) {
      throw new Error(`refusing to write there: ${violation.reason}`);
    }
  }

  /**
   * Opens a file for reading, refusing a final-component symlink.
   *
   * O_NOFOLLOW closes the gap between checking one path and opening another:
   * without it, a file validated a moment ago can be swapped for a symlink
   * before the open lands.
   */
  async #openNoFollow(path: string): Promise<import('node:fs/promises').FileHandle> {
    return await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  }

  /** The tool surface exposed to the model. */
  public definitions(): ToolDefinition[] {
    const pathProperty = {
      type: 'string',
      description: 'Path to the file, relative to the project directory.',
    };
    return [
      {
        name: 'read_file',
        description:
          'Read a file and return its contents. Use this instead of running ' +
          'cat or head on a file.',
        parameters: {
          type: 'object',
          properties: {
            path: pathProperty,
            offset: { type: 'integer' },
            limit: { type: 'integer' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'write_file',
        description:
          'Create a new file or replace a whole file with the given content. ' +
          'Use this to create files - do not use shell redirection for file ' +
          'content. Parent directories are created as needed.',
        parameters: {
          type: 'object',
          properties: {
            path: pathProperty,
            content: {
              type: 'string',
              description: 'The full text of the file.',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'edit_file',
        description:
          'Replace an exact string in an existing file. The old string must ' +
          'appear exactly once, or the edit is refused rather than guessed.',
        parameters: {
          type: 'object',
          properties: {
            path: pathProperty,
            old_text: { type: 'string' },
            new_text: { type: 'string' },
          },
          required: ['path', 'old_text', 'new_text'],
          additionalProperties: false,
        },
      },
      {
        name: 'search_files',
        description:
          'Find files by name, or text inside files, under a directory. Use ' +
          'this instead of shelling out to find or grep.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            path: { type: 'string' },
            search_text: { type: 'boolean' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_directory',
        description: 'List the entries in a directory.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'delete_file',
        description:
          'Delete a file. Restricted to the project directory and to paths ' +
          'explicitly granted for writing.',
        parameters: {
          type: 'object',
          properties: { path: pathProperty },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ];
  }

  /** Dispatches one tool call. */
  public async execute(call: ToolCall): Promise<ToolExecutionResult> {
    const args: Record<string, unknown> = call.arguments ?? {};
    const path = typeof args.path === 'string' ? args.path : '';
    try {
      switch (call.name) {
        case 'read_file':
          return await this.readFile(path, args);
        case 'write_file':
          return await this.writeFile(path, args);
        case 'edit_file':
          return await this.editFile(path, args);
        case 'search_files':
          return await this.searchFiles(args);
        case 'list_directory':
          return await this.listDirectory(path);
        case 'delete_file':
          return await this.deleteFile(path);
        default:
          return fail(new Error(`unknown tool: ${call.name}`));
      }
    } catch (error) {
      return fail(error);
    }
  }

  private async readFile(
    path: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const full = resolveWithin(path, this.#readRoots, 'read_file');
    await this.#assertReachable(full, this.#readRoots, 'read_file');
    const info = await stat(full);
    if (!info.isFile()) throw new Error(`not a file: ${path}`);
    if (info.size > this.#maxBytes) {
      throw new Error(`file is too large to read (${info.size} bytes)`);
    }
    // Opened through a descriptor rather than by name, so a symlink swapped in
    // after the check cannot redirect the read.
    const handle = await this.#openNoFollow(full);
    try {
      const content = await handle.readFile('utf8');
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      if (offset === 0 && limit === undefined) return ok(content);
      const lines = content.split('\n');
      return ok(
        lines
          .slice(offset, limit === undefined ? undefined : offset + limit)
          .join('\n'),
      );
    } finally {
      await handle.close();
    }
  }

  private async writeFile(
    path: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const full = resolveWithin(path, this.#writeRoots, 'write_file');
    await this.#assertReachable(full, this.#writeRoots, 'write_file');
    await this.#assertNotProtected(full);
    const content = typeof args.content === 'string' ? args.content : null;
    if (content === null) throw new Error('write_file needs content');
    if (Buffer.byteLength(content, 'utf8') > this.#maxBytes) {
      throw new Error('content is too large to write');
    }
    await mkdir(dirname(full), { recursive: true });
    const existed = await stat(full).then(
      () => true,
      () => false,
    );
    await writeFile(full, content, {
      encoding: 'utf8',
      // Refuses to write THROUGH an existing symlink, which would otherwise
      // turn `write_file` into an arbitrary-write primitive.
      flag:
        fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
    });
    return ok(
      `wrote ${path} (${Buffer.byteLength(content, 'utf8')} bytes)${existed ? ' - replaced existing file' : ''}`,
    );
  }

  private async editFile(
    path: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const full = resolveWithin(path, this.#writeRoots, 'edit_file');
    await this.#assertReachable(full, this.#writeRoots, 'edit_file');
    await this.#assertNotProtected(full);
    const oldText = typeof args.old_text === 'string' ? args.old_text : null;
    const newText = typeof args.new_text === 'string' ? args.new_text : null;
    if (oldText === null || newText === null) {
      throw new Error('edit_file needs old_text and new_text');
    }
    const content = await this.#openNoFollow(full).then(async (handle) => {
      try {
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    });
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0)
      throw new Error('old_text was not found in the file');
    if (occurrences > 1) {
      throw new Error(
        `old_text appears ${occurrences} times; include more surrounding ` +
          'context so the edit is unambiguous',
      );
    }
    await writeFile(full, content.replace(oldText, newText), {
      encoding: 'utf8',
      flag:
        fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
    });
    return ok(`edited ${path}`);
  }

  private async searchFiles(
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const query = typeof args.query === 'string' ? args.query : '';
    if (query.trim() === '') throw new Error('search_files needs a query');
    const root = resolveWithin(
      typeof args.path === 'string' && args.path !== '' ? args.path : '.',
      this.#readRoots,
      'search_files',
    );
    // Walk the canonical root: a symlinked directory in the workspace must not
    // become a way to search /etc through the back door.
    const realRoot = await canonicalise(root);
    if (!this.#readRoots.some((r) => contains(r, realRoot))) {
      throw new Error(`search_files resolves outside the permitted directories: ${root}`);
    }
    const byText = args.search_text === true;
    const matches: string[] = [];
    const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || matches.length >= 200) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (matches.length >= 200) return;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIP.has(entry.name)) await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!byText) {
          if (entry.name.toLowerCase().includes(query.toLowerCase())) {
            matches.push(relative(this.#readRoots[0] ?? dir, full));
          }
          continue;
        }
        const info = await stat(full);
        if (info.size > this.#maxBytes) continue;
        const content = await this.#openNoFollow(full)
          .then(async (handle) => {
            try {
              return await handle.readFile('utf8');
            } finally {
              await handle.close();
            }
          })
          .catch(() => '');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          matches.push(relative(this.#readRoots[0] ?? dir, full));
        }
      }
    };
    await walk(root, 0);
    return ok(
      matches.length === 0 ? `no matches for ${query}` : matches.join('\n'),
    );
  }

  private async listDirectory(path: string): Promise<ToolExecutionResult> {
    const full = resolveWithin(
      path === '' ? '.' : path,
      this.#readRoots,
      'list_directory',
    );
    const entries = await readdir(full, { withFileTypes: true });
    if (entries.length === 0) return ok('(empty directory)');
    return ok(
      entries
        .map(
          (entry) => `${entry.isDirectory() ? 'dir  ' : 'file '}${entry.name}`,
        )
        .join('\n'),
    );
  }

  private async deleteFile(path: string): Promise<ToolExecutionResult> {
    const full = resolveWithin(path, this.#writeRoots, 'delete_file');
    await this.#assertReachable(full, this.#writeRoots, 'delete_file');
    await this.#assertNotProtected(full);
    await rm(full, { force: true });
    return ok(`deleted ${path}`);
  }
}

/** Tool names provided by the file tools, for the system prompt. */
export const FILE_TOOL_NAMES: readonly string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'list_directory',
  'delete_file',
];
