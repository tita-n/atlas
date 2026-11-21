/**
 * The file tools are a privilege boundary, not a convenience.
 *
 * Every one of these is a case where a lexical path check passes and the write
 * or read still lands somewhere it must never go: a symlink named `notes.txt`
 * pointing at `/etc/passwd`, a `..` that climbs out, a write into Atlas's own
 * state, a git hook that runs later outside any sandbox.
 *
 * The rule these tests encode: the path a tool acts on is judged by where it
 * RESOLVES, never by what it is called.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileTools } from '../../src/shell/file-tools.js';
import {
  atlasInstallRoot,
  canonicalise,
  checkProtectedAbsolute,
  protectedTargets,
} from '../../src/safety/protected-targets.js';

const created: string[] = [];
function temp(prefix = 'atlas-filetools-sec-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const call = (tools: FileTools, name: string, args: Record<string, unknown>) =>
  tools.execute({ id: '1', name, arguments: args });

/** A workspace with its own Atlas home, the shape the product builds. */
function scenario(): {
  workspace: string;
  atlasHome: string;
  tools: FileTools;
} {
  const workspace = temp();
  const atlasHome = join(workspace, 'atlas-home');
  mkdirSync(atlasHome, { recursive: true });
  mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(workspace, '.git', 'config'), '[core]\n');
  return {
    workspace,
    atlasHome,
    tools: new FileTools({
      readRoots: [workspace],
      writeRoots: [workspace],
      atlasHome,
      workspace,
    }),
  };
}

describe('protected targets are one list, not one per caller', () => {
  it('protects the Atlas home, the install tree, and git execution files', () => {
    const home = temp('atlas-home-');
    const targets = protectedTargets(home);
    const paths = targets.map((t) => t.path);
    expect(paths).toContain(join(home));
    expect(paths).toContain(atlasInstallRoot());
  });

  it('classifies a git hook as git-execution, not as a generic write', async () => {
    const { workspace } = scenario();
    const violation = await checkProtectedAbsolute(
      join(workspace, '.git', 'hooks', 'post-checkout'),
      { atlasHome: join(workspace, 'atlas-home'), workspace },
    );
    expect(violation?.kind).toBe('git-execution');
  });
});

describe('write_file', () => {
  it('refuses a path that climbs out with ..', async () => {
    const { tools, workspace } = scenario();
    const result = await call(tools, 'write_file', {
      path: '../escaped.txt',
      content: 'nope',
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(workspace, '..', 'escaped.txt'))).toBe(false);
  });

  it('refuses a symlink that points outside the workspace', async () => {
    const { tools, workspace } = scenario();
    const outside = temp('atlas-outside-');
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'original');
    symlinkSync(outside, join(workspace, 'escape'));

    const result = await call(tools, 'write_file', {
      path: 'escape/secret.txt',
      content: 'overwritten',
    });

    expect(result.isError).toBe(true);
    // The decisive assertion: the file behind the symlink is untouched.
    expect(readFileSync(secret, 'utf8')).toBe('original');
  });

  it('refuses to write through a symlinked file', async () => {
    const { tools, workspace } = scenario();
    const outside = temp('atlas-outside-');
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'original');
    symlinkSync(secret, join(workspace, 'link.txt'));

    const result = await call(tools, 'write_file', {
      path: 'link.txt',
      content: 'overwritten',
    });

    expect(result.isError).toBe(true);
    expect(readFileSync(secret, 'utf8')).toBe('original');
  });

  it('refuses to write into the Atlas home even when it is inside the workspace', async () => {
    const { tools, atlasHome } = scenario();
    const result = await call(tools, 'write_file', {
      path: join(atlasHome, 'config.json'),
      content: '{"apiKey":"stolen"}',
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(atlasHome, 'config.json'))).toBe(false);
  });

  it('refuses to write a git hook that would run outside any sandbox', async () => {
    const { tools, workspace } = scenario();
    const result = await call(tools, 'write_file', {
      path: '.git/hooks/post-checkout',
      content: '#!/bin/sh\nid > /tmp/PWNED\n',
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(workspace, '.git', 'hooks', 'post-checkout'))).toBe(
      false,
    );
  });

  it('refuses to write into .git/config', async () => {
    const { tools, workspace } = scenario();
    const result = await call(tools, 'write_file', {
      path: '.git/config',
      content: '[core]\n\tpager = touch /tmp/PWNED\n',
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe(
      '[core]\n',
    );
  });

  it('still writes an ordinary file', async () => {
    const { tools, workspace } = scenario();
    const result = await call(tools, 'write_file', {
      path: 'src/thing.ts',
      content: 'export const x = 1;\n',
    });
    expect(result.isError).toBeFalsy();
    expect(
      readFileSync(join(workspace, 'src', 'thing.ts'), 'utf8'),
    ).toContain('export const x');
  });
});

describe('read_file', () => {
  it('refuses to read through a symlink out of the workspace', async () => {
    const { tools, workspace } = scenario();
    const outside = temp('atlas-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'classified');
    symlinkSync(outside, join(workspace, 'escape'));

    const result = await call(tools, 'read_file', { path: 'escape/secret.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('classified');
  });
});

describe('search_files', () => {
  it('does not follow a symlinked directory out of the workspace', async () => {
    const { tools, workspace } = scenario();
    const outside = temp('atlas-outside-');
    writeFileSync(join(outside, 'needle.txt'), 'a distinctive needle');
    symlinkSync(outside, join(workspace, 'escape'));

    const result = await call(tools, 'search_files', {
      query: 'needle',
      search_text: true,
    });
    expect(result.content).not.toContain('escape/needle.txt');
  });
});

describe('delete_file', () => {
  it('refuses to delete the Atlas audit database', async () => {
    const { tools, atlasHome } = scenario();
    const db = join(atlasHome, 'atlas.db');
    writeFileSync(db, 'not really a db');
    const result = await call(tools, 'delete_file', { path: db });
    expect(result.isError).toBe(true);
    expect(existsSync(db)).toBe(true);
  });
});

describe('canonicalise', () => {
  it('resolves a symlink to its target', async () => {
    const dir = temp();
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'x');
    symlinkSync(target, join(dir, 'alias.txt'));
    expect(await canonicalise(join(dir, 'alias.txt'))).toBe(target);
  });

  it('keeps the not-yet-existing tail of a create', async () => {
    const dir = temp();
    expect(await canonicalise(join(dir, 'new', 'file.txt'))).toBe(
      join(dir, 'new', 'file.txt'),
    );
  });
});