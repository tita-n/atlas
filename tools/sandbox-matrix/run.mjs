#!/usr/bin/env node
/**
 * Host orchestrator for the two-layer matrix.
 *
 * Rules this file exists to enforce:
 *
 *   - NOTHING is written outside the disposable run directory. Every read-write
 *     bind is checked by `guard.mjs` first, and the guard refuses the real
 *     repository, the real home, and the Step 0 backup outright. A test bug can
 *     ruin the disposable copy; it cannot ruin the work.
 *   - The front-ends and the sandbox both run inside an OUTER bubblewrap whose
 *     only writable surfaces are that disposable copy. The real repository is
 *     never on the mount list.
 *   - A cell whose command never executed is INVALID. There is no code path
 *     here that can turn "the harness failed" into "PASS".
 *
 * Usage:
 *   node run.mjs --self-test-guard
 *   node run.mjs --layer1
 *   node run.mjs --layer2 [--suites A,B] [--frontends chat] [--autonomy unattended]
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertDisposable, DISPOSABLE_ROOT, REAL_HOME, REAL_REPO } from './guard.mjs';

// The matrix reads the selected checkout, then copies only build artifacts into
// the disposable world. Set ATLAS_MATRIX_SOURCE to verify an integration branch
// without accidentally testing the default main checkout.
const SRC = path.resolve(process.env.ATLAS_MATRIX_SOURCE ?? '/home/titan/atlas');
const HARNESS = path.join(SRC, 'tools/sandbox-matrix');
const NODE_MODULES = path.join(SRC, 'node_modules');
const BWRAP = '/usr/bin/bwrap';
const SECRET = 'sk-canary-key-must-never-be-readable';
const PORT = '21800';

/**
 * Tools bound back after `/usr/bin` is replaced, for the C01 container.
 *
 * Deliberately includes `true`: if the probe binary were missing, C01 would
 * "pass" for the wrong reason. With `true` present and `bwrap` absent, the only
 * possible failure is that bubblewrap could not be resolved.
 */
const TOOLS = [
  'sh', 'bash', 'true', 'false', 'env', 'cat', 'ls', 'mkdir', 'rmdir', 'rm',
  'ln', 'touch', 'chmod', 'chown', 'cp', 'mv', 'sleep', 'head', 'tail', 'sort',
  'uniq', 'tr', 'cut', 'wc', 'grep', 'sed', 'awk', 'gawk', 'find', 'xargs',
  'printf', 'echo', 'id', 'whoami', 'pwd', 'date', 'df', 'du', 'ps', 'kill',
  'tar', 'gzip', 'unshare', 'mount', 'umount', 'dirname', 'basename', 'readlink',
  'realpath', 'stat', 'mktemp', 'tee', 'dd', 'yes', 'seq', 'sync', 'getent',
  'which',
  'pkill', 'base64', 'curl', 'python3', 'python3.14', 'node', 'node-22', 'git',
];

const ROOT = DISPOSABLE_ROOT;
const P = (...parts) => path.join(ROOT, ...parts);

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      if (inline !== undefined) args.values[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.values[name] = argv[++i];
      else args.flags.add(name);
    }
  }
  return args;
}

// ---------------------------------------------------------------- guard self-test

function selfTestGuard() {
  const cases = [
    ['the real repository', REAL_REPO],
    ['a path inside the real repository', path.join(REAL_REPO, 'dist')],
    ['the real home', REAL_HOME],
    ['a path inside the real home', path.join(REAL_HOME, '.ssh')],
    ['outside the run directory', '/etc'],
  ];
  let refused = 0;
  for (const [label, target] of cases) {
    try {
      assertDisposable(target, label);
      console.log(`  NOT REFUSED (BUG): ${label} -> ${target}`);
    } catch (error) {
      refused += 1;
      console.log(`  refused: ${error.message.split('\n')[0]}`);
    }
  }
  // And it must ACCEPT a legitimate disposable path.
  const ok = assertDisposable(P('app'), 'app copy');
  console.log(`  accepted: ${ok}`);
  const pass = refused === cases.length;
  console.log(`\nguard self-test: ${pass ? 'PASS' : 'FAIL'} (${refused}/${cases.length} refused)`);
  return pass ? 0 : 1;
}

// ---------------------------------------------------------------- world building

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

function prepareWorld() {
  assertDisposable(ROOT, 'run root');
  for (const dir of ['app', 'template', 'canary', 'fakehome', 'evidence', 'fixtures', 'nobwrap', 'work']) {
    assertDisposable(P(dir), dir);
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const dir of ['app', 'template', 'canary', 'fakehome', 'evidence', 'fixtures', 'nobwrap', 'work']) {
    fs.mkdirSync(P(dir), { recursive: true });
  }

  // The front-end under test: the built CLI and its migrations.
  fs.cpSync(path.join(SRC, 'dist'), P('app', 'dist'), { recursive: true });
  fs.mkdirSync(P('app', 'node_modules'), { recursive: true });
  fs.writeFileSync(P('app', 'package.json'), fs.readFileSync(path.join(SRC, 'package.json')));
  fs.cpSync(path.join(SRC, 'migrations'), P('app', 'migrations'), { recursive: true });

  // The per-cell workspace is a repo-rooted checkout of Atlas itself: the
  // documented condition under which mount-policy pins `src/permissions/**`
  // and `dist/**` inside the writable workspace. `protectedSubpathsIn`
  // anchors on `atlasInstallRoot()`, which resolves from the running
  // module's URL, so the front-end has to run FROM the workspace for that
  // pin to exist there - B29 verifies it with a literal `Read-only file
  // system`, matching the Oct 14 execution report. Written by copying, not
  // by symlink, so a cell cannot reach the real files through it.
  fs.cpSync(path.join(SRC, 'dist'), P('template', 'dist'), { recursive: true });
  fs.cpSync(path.join(SRC, 'migrations'), P('template', 'migrations'), { recursive: true });
  // The real package.json, not a dummy: `"type": "module"` decides how Node
  // parses every file in the copied dist/ the front-end is about to run.
  fs.writeFileSync(P('template', 'package.json'), fs.readFileSync(path.join(SRC, 'package.json')));
  write(P('template', 'src', 'permissions', 'risk-classifier.ts'), fs.readFileSync(path.join(SRC, 'src', 'permissions', 'risk-classifier.ts')));
  for (const name of ['rule-engine.ts', 'autonomy.ts']) {
    write(P('template', 'src', 'permissions', name), fs.readFileSync(path.join(SRC, 'src', 'permissions', name)));
  }
  write(P('template', 'src', 'audit', 'audit-log.ts'), fs.readFileSync(path.join(SRC, 'src', 'audit', 'audit-log.ts')));
  for (const name of ['rule-engine.ts', 'autonomy.ts']) {
    write(P('template', 'src', 'permissions', name), '// workspace source placeholder\n');
  }
  write(P('template', 'src', 'audit', 'audit-log.ts'), '// workspace source placeholder\n');
  write(P('template', 'README.md'), '# disposable workspace\n');
  const gitInit = spawnSync('git', ['init', '-q', P('template')], { encoding: 'utf8' });
  if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);
  fs.mkdirSync(P('template', '.git', 'hooks'), { recursive: true });
  write(P('template', '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho INNER_HOOK_RAN\n');

  // Host canaries: a writable tree that a non-confined command would reach.
  const canaries = {
    'canary-a.txt': 'canary-a',
    'canary-b.txt': 'canary-b',
    'nested/deep-canary.txt': 'deep',
    'usr/canary-f.txt': 'usr',
  };
  for (const [rel, label] of Object.entries(canaries)) {
    write(P('canary', rel), `${label} ${randomUUID()}\n`);
  }

  // A fake home, seeded with the things a real home leaks.
  write(P('fakehome', '.atlas', 'config.json'), JSON.stringify({
    provider: 'openai-compatible',
    apiKey: SECRET,
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    model: 'mock',
  }, null, 2));
  write(P('fakehome', '.ssh', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n');
  write(P('fakehome', '.ssh', 'known_hosts'), 'example.com ssh-ed25519 AAAA\n');
  write(P('fakehome', '.aws', 'credentials'), '[default]\naws_access_key_id = AKIAFAKE\n');
  write(P('fakehome', '.gnupg', 'secring.gpg'), 'fake-gnupg\n');
  write(P('fakehome', '.config', 'google-chrome', 'Default', 'Login Data'), 'fake-logins\n');
  write(P('fakehome', '.config', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: ghp_fake\n');
  write(P('fakehome', '.mozilla', 'firefox', 'cookies.sqlite'), 'fake-cookies\n');
  write(P('fakehome', '.local', 'share', 'keyrings', 'login.keyring'), 'fake-keyring\n');
  write(P('fakehome', '.bash_history'), 'echo fake-history\n');
  write(P('fakehome', '.npmrc'), '//registry.npmjs.org/:_authToken=npm_fake\n');
  write(P('fakehome', '.git-credentials'), 'https://user:pass@github.com\n');
  write(P('fakehome', '.netrc'), 'machine example.com login u password p\n');
  write(P('fakehome', '.kube', 'config'), 'apiVersion: v1\nclusters: []\n');
  write(P('fakehome', '.docker', 'config.json'), '{"auths":{}}\n');
  write(P('fakehome', '.gitconfig'), '[user]\n\tname = fake\n');
  write(P('fakehome', '.bashrc'), 'export FAKE=1\n');
  write(P('fakehome', '.zshrc'), 'export FAKE=1\n');

  // bwrap shadows for the C cells.
  write(P('fixtures', 'bwrap-userns-denied.sh'),
    '#!/bin/sh\necho "bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bwrap>" >&2\nexit 1\n', 0o755);
  write(P('fixtures', 'bwrap-failing.sh'),
    '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n', 0o755);
  write(P('fixtures', 'bwrap-not-executable'), 'not an executable\n', 0o644);

  // A copy of /usr/bin with the bwrap binary removed, for C01 "not resolvable".
  //
  // Hardlink farms do not work here (`/usr` and `/tmp` are different devices),
  // and copying 1.8 GB is wasteful, so C01 instead mounts a tmpfs over
  // `/usr/bin` and binds back a curated list of tools - every one of them
  // `true`-equivalent enough that the probe would otherwise succeed. `bwrap`
  // itself is simply not on the list, so resolution fails before the probe.
  write(P('fixtures', 'tool-list.txt'), TOOLS.join('\n'));
}

// ---------------------------------------------------------------- outer container

function outerArgs(mode, shadowName = '') {
  // The shadow name arrives per call (it names which C cell's broken-bwrap
  // illusion to stage); reading process.env here would miss it, because the
  // runner process itself is outside the container and never has SHADOW set.
  const bwrapShadow = mode === 'layer2c' ? shadowName : '';
  const args = [
    '--new-session', '--die-with-parent',
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--tmpfs', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/var/tmp',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', HARNESS, '/harness',
    '--ro-bind', P('app'), '/app',
    '--ro-bind', NODE_MODULES, '/app/node_modules',
    // The front-end runs from the workspace (see prepareWorld), and Node
    // resolves bare imports by walking up from the module's directory:
    // /work/<cell>/dist -> /work/<cell> -> /work -> /node_modules. Without
    // this bind the workspace-spawned CLI cannot load a single dependency.
    '--ro-bind', NODE_MODULES, '/node_modules',
    '--ro-bind', P('template'), '/template',
    '--bind', P('work'), '/work',
    '--bind', P('canary'), '/canary',
    '--bind', P('fakehome'), '/fakehome',
    '--bind', P('evidence'), '/evidence',
    '--ro-bind', P('fixtures'), '/fixtures',
    '--chdir', '/',
    '--cap-drop', 'ALL',
  ];
  if (bwrapShadow === 'missing') {
    // Replace the whole tool directory with a curated subset that does not
    // include `bwrap`. `/bin` is a symlink to `/usr/bin` here, so one mount
    // covers both. The mount is placed AFTER `--ro-bind /usr /usr` on purpose:
    // later mounts win.
    args.push('--tmpfs', '/usr/bin');
    for (const name of TOOLS) {
      // The curated list names tools the cells and the drivers need; a name
      // the host build happens to drop is skipped and will show up as a real
      // command failure in the cell that needs it, rather than taking the
      // whole shadow down at list-build time.
      let source = null;
      try {
        source = fs.realpathSync(`/usr/bin/${name}`);
      } catch {
        continue;
      }
      args.push('--ro-bind', source, `/usr/bin/${name}`);
    }
  } else if (bwrapShadow === 'not-executable') {
    args.push('--ro-bind', P('fixtures', 'bwrap-not-executable'), '/usr/bin/bwrap');
  } else if (bwrapShadow === 'userns-denied') {
    args.push('--ro-bind', P('fixtures', 'bwrap-userns-denied.sh'), '/usr/bin/bwrap');
  } else if (bwrapShadow === 'failing') {
    args.push('--ro-bind', P('fixtures', 'bwrap-failing.sh'), '/usr/bin/bwrap');
  }
  args.push('--');
  return args;
}

function containerEnv(extra = {}) {
  return {
    HOME: '/work',
    PATH: '/usr/bin:/bin',
    TERM: 'xterm-256color',
    MOCK_PORT: PORT,
    SCRIPT_FILE: '/evidence/script.json',
    PROVIDER_LOG: '/evidence/provider.log',
    ...extra,
  };
}

function runOuter(mode, command, extraEnv = {}) {
  const args = outerArgs(mode, extraEnv.SHADOW ?? '');
  console.log(`\n>>> outer container: ${mode}`);
  const result = spawnSync(BWRAP, [...args, '/bin/sh', '-c', command], {
    stdio: 'inherit',
    // The harness runner's own cwd must never leak into a mount decision: the
    // sandbox binds ITS caller's cwd read-only, and if that were the real
    // repository this whole exercise would be testing the wrong thing.
    cwd: '/home/titan/atlas-evidence-20261113/run',
    env: containerEnv(extraEnv),
  });
  console.log(`<<< outer container ${mode} exited ${result.status}`);
  return result.status;
}

// ---------------------------------------------------------------- reporting

function loadResults(name) {
  const file = P('evidence', `results-${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadJson(name) {
  const file = P('evidence', name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function table(rows, columns) {
  if (rows.length === 0) return '(no rows)';
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(columns.map((c) => r[c.key]))),
  ].join('\n');
}

function reportLayer1(results) {
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  console.log(`\n================ LAYER 1 (${results.length} executions) ================`);
  console.log(table(results, [
    { key: 'cell', header: 'cell' },
    { key: 'profile', header: 'profile' },
    { key: 'verdict', header: 'verdict' },
    { key: 'executed', header: 'exec' },
    { key: 'exitCode', header: 'exit' },
    { key: 'findings', header: 'findings' },
  ]));
  console.log(`\nLayer 1 counts: ${JSON.stringify(counts)}`);
  return counts;
}

function reportLayer2(name, results) {
  if (!results) return {};
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const outcomes = {};
  for (const r of results) outcomes[r.actual] = (outcomes[r.actual] ?? 0) + 1;
  console.log(`\n================ LAYER 2 ${name} (${results.length} runs) ================`);
  console.log(table(results, [
    { key: 'cell', header: 'cell' },
    { key: 'frontend', header: 'front-end' },
    { key: 'autonomy', header: 'autonomy' },
    { key: 'verdict', header: 'verdict' },
    { key: 'toolCalls', header: 'calls' },
    { key: 'expected', header: 'predicted' },
    { key: 'actual', header: 'observed' },
  ]));
  console.log(`\nLayer 2 ${name} verdicts: ${JSON.stringify(counts)}`);
  console.log(`Layer 2 ${name} outcomes: ${JSON.stringify(outcomes)}`);
  const executed = results.filter((r) => r.actual === 'ran-in-sandbox').length;
  const gateDenied = results.filter(
    (r) => r.actual === 'denied-by-floor' || r.actual === 'denied-by-user',
  ).length;
  const invalid = results.filter((r) => r.verdict === 'INVALID').length;
  console.log(
    `Layer 2 ${name}: total=${results.length} executed-in-sandbox=${executed} ` +
      `gate-denied=${gateDenied} INVALID=${invalid}`,
  );
  const byFrontend = {};
  for (const r of results) {
    const key = `${r.frontend}/${r.autonomy}`;
    byFrontend[key] = byFrontend[key] ?? {};
    byFrontend[key][r.actual] = (byFrontend[key][r.actual] ?? 0) + 1;
  }
  console.log('\nPer front-end / autonomy outcome counts (the parity claim):');
  for (const [key, value] of Object.entries(byFrontend)) {
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
  return counts;
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs();

  if (args.flags.has('self-test-guard')) {
    process.exit(selfTestGuard());
  }

  const harnessGuard = spawnSync(process.execPath, ['-e', `
    import('${HARNESS}/guard.mjs').then(({ assertDisposable, REAL_REPO }) => {
      try { assertDisposable(REAL_REPO, 'real repo'); console.log('GUARD DID NOT REFUSE'); process.exit(1); }
      catch (e) { console.log('GUARD REFUSED: ' + e.message.split('\\n')[0]); process.exit(0); }
    });
  `], { encoding: 'utf8' });
  console.log(`guard check: ${harnessGuard.stdout.trim() || harnessGuard.stderr.trim()}`);
  if (harnessGuard.status !== 0) {
    console.error('REFUSING TO RUN: the harness-start guard did not refuse the real repository.');
    process.exit(1);
  }

  prepareWorld();
  const summary = {};

  if (args.flags.has('layer1') || args.flags.has('all')) {
    const env = {};
    if (args.values.suites) env.L1_SUITES = args.values.suites;
    if (args.values.ids) env.L1_IDS = args.values.ids;
    runOuter('layer1', 'node /harness/inside.mjs layer1', env);
    const results = loadResults('layer1') ?? [];
    summary.layer1 = reportLayer1(results);
  }

  if (args.flags.has('layer2') || args.flags.has('layer2c') || args.flags.has('all')) {
    const env = {};
    if (args.values.suites) env.L2_SUITES = args.values.suites;
    if (args.values.frontends) env.L2_FRONTENDS = args.values.frontends;
    if (args.values.autonomy) env.L2_AUTONOMY = args.values.autonomy;
    if (args.values.ids) env.L2_IDS = args.values.ids;
    const startProvider = 'node /harness/mock-provider.mjs > /evidence/provider-stderr.log 2>&1 & ' +
      'sleep 0.8; ';
    if (!args.flags.has('layer2c')) {
    runOuter(
      'layer2',
      `${startProvider}node /harness/inside.mjs layer2; rc=$?; kill %1 2>/dev/null; wait 2>/dev/null; exit $rc`,
      env,
    );
    }

    // C cells need a container where bubblewrap is unusable.
    const shadows = [
      ['missing', 'C01'],
      ['not-executable', 'C02'],
      ['userns-denied', 'C03'],
      ['failing', 'C04'],
    ];
    for (const [shadow, cellId] of shadows) {
      const shadowEnv = { ...env, SHADOW: shadow, L2_CIDS: cellId, L2_SUITES: 'C' };
      runOuter(
        'layer2c',
        `${startProvider}node /harness/inside.mjs layer2c; rc=$?; kill %1 2>/dev/null; wait 2>/dev/null; exit $rc`,
        shadowEnv,
      );
      const produced = loadJson('results-layer2c.json');
      if (produced) write(P('evidence', `results-layer2c-${shadow}.json`), JSON.stringify(produced, null, 2));
    }
    if (!args.flags.has('layer2c')) summary.layer2 = reportLayer2('', loadResults('layer2'));
    for (const [shadow] of shadows) {
      summary[`layer2c-${shadow}`] = reportLayer2(shadow, loadJson(`results-layer2c-${shadow}.json`));
    }
  }

  fs.writeFileSync(P('evidence', 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nsummary written to ${P('evidence', 'summary.json')}`);
  console.log(`sha256 of dist/permissions/default-rules.js (front-end under test): ${
    createHash('sha256').update(fs.readFileSync(path.join(SRC, 'dist', 'permissions', 'default-rules.js'))).digest('hex')
  }`);
}

main();
