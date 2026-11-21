import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(process.cwd(), 'src');

// Process creation is restricted to the execution broker and explicit
// operator/voice subsystems. Add a module only with a reviewed reason here.
const processAllowlist: Record<string, string> = {
  'execution/bwrap/bwrap-environment.ts': 'starts bwrap with a fixed argv array',
  'permissions/sudoers-setup.ts': 'human-confirmed, scoped system setup',
  'selfmod/cli.ts': 'operator-facing selfmod command wrapper',
  'selfmod/runner.ts': 'isolated selfmod validation and apply runner',
  'shell/shell-session.ts': 'the single execution-session process broker',
  'voice/audio-capture.ts': 'starts the configured audio capture backend',
  'voice/model-manager.ts': 'extracts a fixed archive using a fixed tar argv',
  'voice/speaker-verification.ts': 'starts the configured speaker verifier',
};

// Direct filesystem mutation is similarly confined to explicit persistence,
// migration, model-management, and user-scoped file-tool modules.
const filesystemWriteAllowlist: Record<string, string> = {
  'config/config.ts': 'atomic user configuration persistence',
  'conversation/assistant-runtime.ts': 'exclusive session lock lifecycle',
  'conversation/personality.ts': 'user personality file initialization',
  'conversation/session.ts': 'one-time user notice marker and scoped FileTools dispatch',
  'execution/full-access.ts': 'operator full-access grant and evidence files',
  'execution/trust.ts': 'operator trust records and evidence files',
  'memory/database.ts': 'creates the configured application data directory',
  'permissions/autonomy.ts': 'operator autonomy settings',
  'permissions/grant-store.ts': 'durable command-grant persistence',
  'permissions/sudoers-setup.ts': 'temporary scoped sudoers setup file',
  'providers/model-registry.ts': 'provider catalogue cache',
  'selfmod/ledger.ts': 'append-only selfmod audit ledger',
  'selfmod/runner.ts': 'selfmod candidate write inside validated scope',
  'shell/file-tools.ts': 'model-facing writes constrained by protected-path policy',
  'voice/backends/sherpa-onnx/wake-word.ts': 'generated wake-word configuration under model data root',
  'voice/enrollment.ts': 'operator-enrolled voice samples under private data root',
  'voice/model-manager.ts': 'downloaded voice assets under managed model root',
  'voice/voice-pipeline.ts': 'temporary audio artifacts in the configured workspace',
  'voice/voiceprint-store.ts': 'private operator voiceprint persistence',
};

const processModules = /(?:from\s*|import\s*\(?\s*)['"]node:child_process['"]|require\s*\(\s*['"]node:child_process['"]\s*\)/;
const writeApis = new Set([
  'appendFile',
  'appendFileSync',
  'chmod',
  'createWriteStream',
  'mkdir',
  'mkdirSync',
  'open',
  'openSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync',
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await sourceFiles(path);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('security-sensitive imports', () => {
  it('keeps process spawning within the explicit allowlist', async () => {
    const files = await sourceFiles(sourceRoot);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (processModules.test(source)) {
        const module = relative(sourceRoot, file);
        if (processAllowlist[module] === undefined) violations.push(module);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps direct filesystem mutation imports within the explicit allowlist', async () => {
    const files = await sourceFiles(sourceRoot);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const module = relative(sourceRoot, file);
      const importedNames = new Set<string>();
      for (const match of source.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*['"]node:fs(?:\/promises)?['"]/gs,
      )) {
        for (const item of (match[1] ?? '').split(',')) {
          const name = item.trim().split(/\s+as\s+/)[0];
          if (name !== undefined && writeApis.has(name)) importedNames.add(name);
        }
      }
      if (/import\s+\*\s+as\s+\w+\s+from\s+['"]node:fs(?:\/promises)?['"]/.test(source)) {
        importedNames.add('*');
      }
      if (importedNames.size > 0 && filesystemWriteAllowlist[module] === undefined) {
        violations.push(`${module}: ${[...importedNames].join(', ')}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
