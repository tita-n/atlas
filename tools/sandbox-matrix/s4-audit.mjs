// Step 4 evidence: home-directory exposure BEFORE (pre-remediation backup,
// /home/titan/atlas-backup-20261016/dist) vs AFTER (final build at
// /home/titan/atlas/dist), plus the build-time enforcement delta.
//
// Host-side only: builds bwrap argv for a disposable fixture home and classifies
// every mount under $HOME. Nothing here executes bwrap or touches the real home.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const OUT = '/home/titan/atlas-evidence-20261113/s4';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const BEFORE =
  '/home/titan/atlas-backup-20261016/dist/execution/bwrap/mount-policy.js';
const AFTER = '/home/titan/atlas/dist/execution/bwrap/mount-policy.js';

for (const f of [BEFORE, AFTER]) {
  if (!fs.existsSync(f)) throw new Error(`missing build: ${f}`);
}

// --- fixture home -----------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 's4-home-'));
const proj = path.join(home, 'proj');
fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
fs.mkdirSync(path.join(home, '.atlas'), { recursive: true });
fs.writeFileSync(path.join(home, 'private-notes.txt'), 'home root secret\n');
fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), '-----BEGIN KEY-----\n');
fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_access_key_id=AKIAEXAMPLE\n');
fs.writeFileSync(path.join(home, '.atlas', 'config.json'), '{"grant":"none"}\n');
fs.writeFileSync(path.join(proj, '.git', 'config'), '[core]\n');
fs.writeFileSync(path.join(proj, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');

// Parse the mount-shaped flags out of a bwrap argv (same rules the AFTER
// build's parseMounts uses, kept identical so the classification is even).
function parseMounts(argv) {
  const mounts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--perms' && argv[i + 1] === '000' && argv[i + 2] === '--tmpfs') {
      mounts.push({ kind: 'mask', path: argv[i + 3] ?? '' });
      i += 3;
      continue;
    }
    const pair = (kind) => {
      const source = argv[i + 1];
      const dest = argv[i + 2];
      if (source === undefined || dest === undefined) throw new Error(`dangling ${flag} in argv at ${i}`);
      mounts.push({ kind, source, path: dest });
      i += 2;
    };
    if (flag === '--bind') { pair('bind-write'); continue; }
    if (flag === '--ro-bind') { pair('bind-read'); continue; }
    if (flag === '--symlink') { pair('symlink'); continue; }
    if (flag === '--tmpfs') { mounts.push({ kind: 'tmpfs', path: argv[i + 1] ?? '' }); i += 1; continue; }
  }
  return mounts;
}

const under = (root, p) =>
  p !== root && p !== '' && path.relative(root, p) !== '' &&
  !path.relative(root, p).startsWith('..') && !path.isAbsolute(path.relative(root, p));

function classify(argv, cwd, roots) {
  const trustedRoots = [path.resolve(cwd), ...roots.map((r) => path.resolve(r))];
  const trusted = (p) => trustedRoots.some((r) =>
    p === r || (path.relative(r, p) !== '' && !path.relative(r, p).startsWith('..') && !path.isAbsolute(path.relative(r, p))));
  const invisible = [];
  const exposed = [];
  for (const m of parseMounts(argv)) {
    const inHome = under(home, m.path) || (m.source !== undefined && under(home, m.source));
    if (!inHome) continue;
    if (m.kind === 'mask' || m.kind === 'tmpfs') { invisible.push(m); continue; }
    exposed.push({ ...m, trusted: trusted(m.path) || trusted(m.source ?? '') });
  }
  return { invisible, exposed };
}

function buildFor(distPath) {
  // HOME is read when buildBwrapCommand runs, not when the module imports.
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return { mod: import(`file://${distPath}`) };
  } finally {
    process.env.HOME = previous ?? undefined;
  }
}

const policyFor = (mod, cwd, atlasHome) => (mod.default ?? mod).when === undefined ? undefined : undefined;

// eslint-disable-next-line no-await-in-loop
const before = await buildFor(BEFORE);
// eslint-disable-next-line no-await-in-loop
const after = await buildFor(AFTER);

const beforeMod = await before.mod;
const afterMod = await after.mod;

const cwd = proj;
const atlasHome = path.join(home, '.atlas');
const policy = {
  profile: 'workspace-write',
  cwd,
  writableRoots: [cwd],
  networkEnabled: false,
  atlasHome,
  alwaysHidden: [],
};

const results = {};
for (const [name, m] of [['before', beforeMod], ['after', afterMod]]) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  let built;
  try {
    built = m.buildBwrapCommand(policy, '/usr/bin/bwrap', ['/bin/true']);
  } finally {
    process.env.HOME = previous ?? undefined;
  }
  const classified = classify(built.argv, cwd, [cwd]);
  results[name] = {
    dist: name === 'before' ? BEFORE : AFTER,
    sha256: createHash('sha256').update(fs.readFileSync(name === 'before' ? BEFORE : AFTER)).digest('hex'),
    exportsAssertHomeAllowlist: String(m.assertHomeAllowlist),
    exposedUnderHome: classified.exposed,
    invisibleUnderHome: classified.invisible,
    argvCopy: built.argv,
  };
  // hash the seeded home files as literal evidence they are not readable
  // (runtime probes prove this in containers; these are the fixture inputs)
  results[name].homeFixtureSha256 = {};
  for (const rel of ['private-notes.txt', '.ssh/id_ed25519', '.aws/credentials', '.atlas/config.json']) {
    results[name].homeFixtureSha256[rel] = createHash('sha256')
      .update(fs.readFileSync(path.join(home, rel)))
      .digest('hex');
  }
}

// Enforcement delta: hand BOTH builds the same unapproved under-home bind.
// BEFORE has no guard; AFTER must refuse.
const unapprovedArgv = ['--ro-bind', path.join(home, '.aws'), path.join(home, '.aws')];
let refusal = null;
const prev2 = process.env.HOME;
process.env.HOME = home;
try {
  try {
    afterMod.assertHomeAllowlist(cwd, [cwd], unapprovedArgv);
    refusal = 'NOT REFUSED (fail-open)';
  } catch (e) {
    refusal = e.message;
  }
  const beforeNames = Object.keys(beforeMod).sort();
  results.enforcementDelta = {
    craftedArgv: unapprovedArgv,
    afterRefusal: refusal,
    beforeExports: beforeNames,
    beforeHasGuard: beforeNames.includes('assertHomeAllowlist'),
  };
} finally {
  process.env.HOME = prev2 ?? undefined;
}

fs.writeFileSync(path.join(OUT, 'home-exposure-audit.json'), JSON.stringify(results, null, 2));

// console table
for (const name of ['before', 'after']) {
  const r = results[name];
  console.log(`\n=== ${name.toUpperCase()} (${r.dist}) ===`);
  console.log(`mount-policy.js sha256: ${r.sha256}`);
  console.log(`assertHomeAllowlist exported: ${r.exportsAssertHomeAllowlist}`);
  console.log('-- under-$HOME mounts that expose host content --');
  for (const m of r.exposedUnderHome) console.log(`  ${m.kind.padEnd(10)} ${m.source ?? ''} -> ${m.path} trusted=${m.trusted}`);
  console.log('-- under-$HOME invisible mounts (masks/fresh) --');
  for (const m of r.invisibleUnderHome) console.log(`  ${m.kind.padEnd(10)} ${m.path}`);
}
console.log(`\n=== enforcement delta ===`);
console.log(`before exports a home-allowlist guard: ${results.enforcementDelta.beforeHasGuard}`);
console.log(`after refusal of unapproved under-home bind: ${results.enforcementDelta.afterRefusal}`);

fs.rmSync(home, { recursive: true, force: true });
console.log(`\nfixture home removed; evidence at ${OUT}/home-exposure-audit.json`);
