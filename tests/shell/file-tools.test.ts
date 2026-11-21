import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileTools } from '../../src/shell/file-tools.js';

const roots: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-file-tools-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function toolsFor(dir: string, writes: string[] = [dir]): FileTools {
  return new FileTools({ readRoots: [dir], writeRoots: writes });
}
const call = (tools: FileTools, name: string, args: Record<string, unknown>) =>
  tools.execute({ id: '1', name, arguments: args });

describe('file tools', () => {
  it('exposes a real tool surface, not just a shell', () => {
    const names = toolsFor(workspace())
      .definitions()
      .map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'read_file',
        'write_file',
        'edit_file',
        'search_files',
        'list_directory',
      ]),
    );
  });

  it('creates a file, including parent directories', async () => {
    const dir = workspace();
    const result = await call(toolsFor(dir), 'write_file', {
      path: 'src/deep/alpha.ts',
      content: 'export const a = 1;\n',
    });
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(dir, 'src/deep/alpha.ts'))).toBe(true);
  });

  it('reads a file back', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const result = await call(toolsFor(dir), 'read_file', { path: 'a.txt' });
    expect(result.content).toBe('hello');
  });

  it('edits an existing file and refuses an ambiguous match', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'a.txt'), 'x y x');
    const ok = await call(toolsFor(dir), 'edit_file', {
      path: 'a.txt',
      old_text: 'x y x',
      new_text: 'z',
    });
    expect(ok.isError).toBeUndefined();
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('z');

    writeFileSync(join(dir, 'b.txt'), 'dup dup');
    const ambiguous = await call(toolsFor(dir), 'edit_file', {
      path: 'b.txt',
      old_text: 'dup',
      new_text: 'x',
    });
    expect(ambiguous.isError).toBe(true);
  });

  it('searches by name and by text', async () => {
    const dir = workspace();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'needle.txt'), 'haystack');
    const byName = await call(toolsFor(dir), 'search_files', {
      query: 'needle',
    });
    expect(byName.content).toContain('needle.txt');
    const byText = await call(toolsFor(dir), 'search_files', {
      query: 'haystack',
      search_text: true,
    });
    expect(byText.content).toContain('needle.txt');
  });

  it('lists a directory', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'one.txt'), '');
    const result = await call(toolsFor(dir), 'list_directory', { path: '.' });
    expect(result.content).toContain('one.txt');
  });

  it('refuses to write outside the permitted roots', async () => {
    const dir = workspace();
    const tools = toolsFor(dir);
    const escape = await call(tools, 'write_file', {
      path: '../../escaped.ts',
      content: 'x',
    });
    expect(escape.isError).toBe(true);
    expect(escape.content).toMatch(/outside the permitted directories/);
  });

  it('refuses to read outside the permitted roots', async () => {
    const dir = workspace();
    const result = await call(toolsFor(dir), 'read_file', {
      path: '/etc/hostname',
    });
    expect(result.isError).toBe(true);
  });

  it('honours an absolute path that is inside a root', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'abs.txt'), 'ok');
    const result = await call(toolsFor(dir), 'read_file', {
      path: join(dir, 'abs.txt'),
    });
    expect(result.content).toBe('ok');
  });

  it('deletes a file', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'gone.txt'), '');
    const result = await call(toolsFor(dir), 'delete_file', {
      path: 'gone.txt',
    });
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
  });

  it('reports an unknown tool rather than throwing', async () => {
    const result = await call(toolsFor(workspace()), 'nope', {});
    expect(result.isError).toBe(true);
  });
});
