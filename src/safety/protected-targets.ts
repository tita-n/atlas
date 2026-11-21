/**
 * One list of paths Atlas must never be talked into writing.
 *
 * Previously the only such list was repo-relative and lived with the self-mod
 * workflow, which is the wrong shape for a runtime decision: the file tools and
 * a future sandbox mount policy both need to ask "is this absolute path
 * off-limits?" and neither can answer it by comparing against
 * `src/permissions/default-rules.ts`.
 *
 * The rule this module exists to enforce is the one that actually matters: a
 * second, hand-copied list is how `dist/` ended up unprotected while every
 * source file was. So there is one list, computed here, and the self-mod
 * repo-relative list is folded into it rather than restated beside it.
 *
 * Three things are protected, for three different reasons:
 *
 *   1. Atlas's own state - config, API keys, the audit database, autonomy
 *      settings. Writing here either steals credentials or erases the record.
 *   2. Atlas's own code, sources and the compiled output Node actually runs.
 *      Writing here changes the safety rules without changing their source.
 *   3. `.git/hooks` and `.git/config`. These are inside the workspace, so a
 *      workspace-write profile would otherwise make them writable - and
 *      anything written there executes later, outside the sandbox, the moment
 *      the user runs git.
 *
 * Absolute paths are canonicalised with realpath semantics before comparison.
 * A boundary checked against a symlink's own name is not a boundary.
 */

import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { protectedPaths as selfmodRepoPaths } from '../selfmod/protected-paths.js';

/** Why a path is off-limits, in words a user can act on. */
export type ProtectedReason = 'atlas-state' | 'atlas-code' | 'git-execution';

export interface ProtectedTarget {
  /** What kind of thing this is, for the mount policy and the audit log. */
  readonly kind: 'directory' | 'file';
  readonly path: string;
  readonly reason: ProtectedReason;
}

export interface ProtectedTargetViolation {
  readonly path: string;
  readonly reason: string;
  readonly kind: ProtectedReason;
}

const REASON_TEXT: Record<ProtectedReason, string> = {
  'atlas-state':
    'This is Atlas state: configuration, API keys, the audit database, or ' +
    'autonomy settings. Writing here would change what Atlas is allowed to do ' +
    'or erase the record of what it has done.',
  'atlas-code':
    "This is Atlas's own safety code, or the compiled output it runs. " +
    'Rewriting it would change the rules without changing their source.',
  'git-execution':
    'This file is executed by git outside any sandbox the next time the user ' +
    'runs a git command. A sandbox cannot help here, so the write is refused ' +
    'at the boundary instead.',
};

/**
 * The package root of the running Atlas: the nearest ancestor with a
 * package.json.
 *
 * Resolved from this module's own URL rather than from process.cwd(), so a
 * session started anywhere still protects the code that is actually running.
 */
export function atlasInstallRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Directories under the install root that hold runnable code. */
const CODE_DIRECTORIES: readonly string[] = ['dist/', 'src/permissions/'];

/**
 * Compiled counterparts of the repo-relative protected sources.
 *
 * Derived, never restated: the previous gap was exactly a hand-written list
 * that forgot `dist/`.
 */
function compiledProtectedSources(installRoot: string): readonly string[] {
  return selfmodRepoPaths()
    .files.filter((file) => file.endsWith('.ts'))
    .map((file) => join(installRoot, file.replace(/\.ts$/, '.js')));
}

/** Every path protected in this Atlas state, given where its home is. */
export function protectedTargets(atlasHome: string): readonly ProtectedTarget[] {
  const installRoot = atlasInstallRoot();
  const targets: ProtectedTarget[] = [];

  // 1. Atlas state. The whole home, not a spot list: a new file added there
  // tomorrow is protected without anyone remembering to add it.
  targets.push({
    kind: 'directory',
    path: resolve(atlasHome),
    reason: 'atlas-state',
  });

  // 2. Atlas code. The install root as a whole is the conservative choice:
  // it is Atlas itself, and a future module nobody enumerated must fail closed.
  targets.push({
    kind: 'directory',
    path: resolve(installRoot),
    reason: 'atlas-code',
  });
  for (const directory of CODE_DIRECTORIES) {
    targets.push({
      kind: 'directory',
      path: join(installRoot, directory),
      reason: 'atlas-code',
    });
  }
  for (const compiled of compiledProtectedSources(installRoot)) {
    targets.push({ kind: 'file', path: resolve(compiled), reason: 'atlas-code' });
  }
  for (const directory of selfmodRepoPaths().directories) {
    targets.push({
      kind: 'directory',
      path: join(installRoot, directory),
      reason: 'atlas-code',
    });
  }

  return targets;
}

/**
 * `.git` hooks and config for a workspace, protected because git runs them.
 *
 * Takes the workspace rather than the cwd so the mount policy and the file
 * tools agree on one answer for a given project.
 */
export function protectedGitTargets(
  workspace: string,
): readonly ProtectedTarget[] {
  const gitDir = join(resolve(workspace), '.git');
  return [
    { kind: 'directory', path: join(gitDir, 'hooks'), reason: 'git-execution' },
    { kind: 'file', path: join(gitDir, 'config'), reason: 'git-execution' },
  ];
}

/**
 * True when `candidate` is `root` or lives under it.
 *
 * Exported because the mount policy needs the same answer: a string
 * `${root}/` prefix test silently returns nothing for `root === '/'`
 * (the prefix becomes `//`, which no absolute path starts with), which is how
 * a `/` writable root ended up with none of its protected subpaths pinned.
 */
export function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Canonicalises a path the way the filesystem will see it.
 *
 * realpath on the deepest existing ancestor, because the file being written
 * usually does not exist yet - and `link -> /etc/passwd` must be judged by
 * where it points, not by what it is called. Missing leaves are appended
 * unchanged so a create is still checked.
 */
export async function canonicalise(path: string): Promise<string> {
  const absolute = resolve(path);
  const segments: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      const real = await realpath(probe);
      return segments.length === 0
        ? real
        : join(real, ...segments.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute;
      segments.push(probe.slice(parent.length + (probe.endsWith(sep) ? 0 : 1)));
      probe = parent;
    }
  }
}

/**
 * Whether an absolute path is protected, and why.
 *
 * Both the path and the nearest existing ancestor are checked, so a symlink
 * pointing at a protected target is refused for what it resolves to.
 */
export async function checkProtectedAbsolute(
  path: string,
  context: { atlasHome: string; workspace?: string | undefined },
): Promise<ProtectedTargetViolation | undefined> {
  const resolved = resolve(path);
  const real = await canonicalise(resolved);
  const targets = [
    ...protectedTargets(context.atlasHome),
    ...(context.workspace === undefined
      ? []
      : protectedGitTargets(context.workspace)),
  ];
  for (const target of targets) {
    if (contains(target.path, resolved) || contains(target.path, real)) {
      return {
        path,
        reason: REASON_TEXT[target.reason],
        kind: target.reason,
      };
    }
  }
  return undefined;
}