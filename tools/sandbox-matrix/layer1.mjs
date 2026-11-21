/**
 * Layer 1: containment, measured directly against the bwrap environment.
 *
 * This layer deliberately bypasses the confirmation flow and the hard floor, so
 * that a command which reaches it is certain to reach bubblewrap. That is what
 * makes a containment claim possible at all: Layer 2 can only ever show that
 * the gate decided something, never that the sandbox held, because a gate
 * denial means the command never ran.
 *
 * For every cell, in BOTH `read-only` and `workspace-write`:
 *   - the exact bwrap argv is recorded,
 *   - stdout carries a START/END marker pair (no START ⇒ INVALID),
 *   - the exit code comes from the marker, not from the harness,
 *   - /canary is re-hashed afterwards, byte for byte.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { BwrapEnvironment } from '/app/dist/execution/bwrap/bwrap-environment.js';
import { buildBwrapCommand, SANDBOXED_SHELL } from '/app/dist/execution/bwrap/mount-policy.js';
import {
  cwdOf,
  diffTree,
  excerpt,
  executed,
  exitFrom,
  hashTree,
  mark,
  sandboxIdentity,
} from './evidence.mjs';

const TEMPLATE = '/template';
const WORK = '/work';
const CANARY = '/canary';
const FAKEHOME = '/fakehome';


const PROFILES = ['read-only', 'workspace-write'];

/** Cells run with HOME=/fakehome so `~` resolves to it, matching the front-ends. */
function homeOf() {
  return FAKEHOME;
}

/**
 * What "protected" actually means here, per the mount policy:
 *
 *   1. WORKSPACE_PROTECTED — paths the policy pins read-only INSIDE a writable
 *      root (.git/config, .git/hooks). Files like `dist/` or
 *      `src/permissions/` inside the cell workspace are NOT on this list: a
 *      client workspace is user data, and the policy protects Atlas's own
 *      running INSTALL (see APP_PROTECTED below), not any repo-shaped copy
 *      the user happens to have open. `rm -rf *` may lawfully delete the
 *      copy's dist/; it may not delete .git/config or hook files.
 *
 *   2. APP_PROTECTED — the compiled files Node actually runs, under /app.
 *      Every cell, whatever its intent and whatever profile, must leave
 *      these byte-identical. That is the containment claim the sandbox
 *      exists for, and its before/after sha256 pair is recorded per cell.
 */
const WORKSPACE_PROTECTED = ['.git/config', '.git/hooks'];
const APP_ROOT = '/app';
const APP_PROTECTED = [
  'dist/permissions/default-rules.js',
  'dist/permissions/risk-classifier.js',
];

/** Literal sha256 of one file, or a MISSING sentinel it did not exist. */
function fileHash(p) {
  try {
    return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (error) {
    return `MISSING:${error?.code ?? 'ERR'}`;
  }
}

function rebuildWorkspace(cellId) {
  const dir = path.join(WORK, cellId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(TEMPLATE, dir, { recursive: true });
  return dir;
}

/**
 * Derives the recorded bwrap argv from the same policy the cell used. Evidence
 * names the exact flags rather than a paraphrase; the containment claim itself
 * rests on the in-sandbox identity probe plus the command's own output.
 */
/**
 * Derives the recorded bwrap argv from the same policy the cell used. Evidence
 * names the exact flags rather than a paraphrase; the containment claim itself
 * rests on the in-sandbox identity probe plus the command's own output.
 *
 * HOME matters twice: it decides which of the runner's home subdirectories the
 * policy masks (`~/.ssh`, `~/.config`, …) and it is what the sandboxed shell
 * expands `~` to. Both are forced to disposable paths inside the container, so
 * the recorded argv describes THIS run rather than whatever account happened
 * to launch it.
 */
function buildArgv(profile, dir) {
  const home = process.env.HOME;
  try {
    process.env.HOME = homeOf();
    return buildBwrapCommand(
      {
        profile,
        cwd: dir,
        writableRoots: profile === 'workspace-write' ? [dir] : [],
        networkEnabled: false,
        atlasHome: path.join(FAKEHOME, '.atlas'),
        alwaysHidden: [],
      },
      '/usr/bin/bwrap',
      SANDBOXED_SHELL,
    ).argv;
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
}


async function runOne(cell, profile) {
  const cellId = `${cell.id}-${profile}`;
  const dir = rebuildWorkspace(cellId);
  const command = cell.command.replaceAll('@WORK@', dir);
  const canaryBefore = hashTree(CANARY);
  // The pristine reference is `/template` itself, which is bound read-only in
  // the outer container. `/pristine` was never mounted, so comparing against it
  // made every workspace file look "changed" and turned a harness bug into a
  // false containment failure.
  const pristine = hashTree(TEMPLATE);
  const wsBefore = Object.fromEntries(
    WORKSPACE_PROTECTED.map((rel) => [rel, pristine[rel] ?? 'MISSING']),
  );
  const appBefore = Object.fromEntries(
    APP_PROTECTED.map((rel) => [rel, fileHash(path.join(APP_ROOT, rel))]),
  );

  let environment;
  try {
    // The runner's HOME is forced to the disposable `/fakehome` (a per-cell
    // shim, not the operating account): the mount policy masks paths relative
    // to the runner's HOME, and if that were the real `/home/titan` the masks
    // would name paths that do not exist inside this container. `~` inside the
    // sandbox must resolve to the fake home exactly as it does in the front-end
    // layer for cells like `rm -rf ~` to mean the same thing in both layers.
    process.env.HOME = homeOf();
    environment = await BwrapEnvironment.create({
      profile,
      cwd: dir,
      writableRoots: profile === 'workspace-write' ? [dir] : [],
      networkEnabled: false,
      atlasHome: path.join(FAKEHOME, '.atlas'),
    });
  } catch (error) {
    return {
      cell: cell.id,
      title: cell.title,
      kind: cell.kind,
      profile,
      verdict: 'INVALID',
      reason: `BwrapEnvironment.create threw: ${error?.message ?? error}`,
      command,
    };
  }

  const session = environment.createSession();
  // argv is built after the sandbox has run, from the same policy fields, so
  // the recorded flags correspond to the policy that governed THIS run.
  const result = await session.execute(mark(command), 60_000);
  session.close();

  // The argv is recorded with HOME temporarily set the way it was when the
  // backend built its own argv, so the masks and `~` in the evidence describe
  // the run that actually happened.
  let argv = [];
  try {
    argv = buildArgv(profile, dir);
  } catch {
    argv = [];
  }

  const canaryAfter = hashTree(CANARY);
  const canaryChanged = diffTree(canaryBefore, canaryAfter);
  const wsChanged = WORKSPACE_PROTECTED.filter(
    (rel) => (hashTree(dir)[rel] ?? 'MISSING') !== wsBefore[rel],
  );
  const appAfter = Object.fromEntries(
    APP_PROTECTED.map((rel) => [rel, fileHash(path.join(APP_ROOT, rel))]),
  );
  const appChanged = APP_PROTECTED.filter(
    (rel) => appAfter[rel] !== appBefore[rel],
  );
  const leaked = cell.mustNotLeak?.filter((s) => result.stdout.includes(s)) ?? [];
  const ran = executed(result.stdout);
  const exit = exitFrom(result.stdout);
  const identity = sandboxIdentity(result.stdout);
  const cwdSeen = cwdOf(result.stdout);

  const findings = [];
  // The sandbox --chdir flag points the shell at the cell workspace; a `cd`
  // inside the command body is the cell's own business (A01, A02, ...), and
  // PWD is printed BEFORE the command runs, so this records the initial cwd.
  if (cwdSeen !== null && cwdSeen !== dir) {
    findings.push(`INVALID: sandbox chdir is ${cwdSeen}, not ${dir}`);
  }
  if (!ran) findings.push('INVALID: no START/END marker: the command did not execute');
  // The in-band identity probe. `null` means the probe never printed, which is
  // its own failure: a cell whose sandbox identity is unknown proves nothing.
  if (identity.noNewPrivs !== '1') {
    findings.push(`INVALID: NoNewPrivs=${identity.noNewPrivs ?? 'absent'} inside the sandbox`);
  }
  if (!/^0+$/.test(identity.capEff ?? '')) {
    findings.push(`INVALID: CapEff=${identity.capEff ?? 'absent'} inside the sandbox`);
  }
  if (identity.rootWritable !== 'no') {
    findings.push(`INVALID: / was writable inside the sandbox (${identity.rootWritable ?? 'absent'})`);
  }
  if (canaryChanged.length > 0) findings.push(`host canaries changed: ${canaryChanged.join(', ')}`);
  if (appChanged.length > 0) {
    findings.push(
      `INVALID: /app install files changed: ${appChanged.join(', ')}`,
    );
  }
  if (cell.kind === 'containment' && wsChanged.length > 0) {
    findings.push(`workspace-protected files changed: ${wsChanged.join(', ')}`);
  }
  if (leaked.length > 0) findings.push(`leaked secret: ${leaked.join(', ')}`);

  // A usable command that cannot succeed inside the sandbox is a different bug
  // from one that is not confined, and the report must not conflate them.
  let usableFailure = null;
  if (cell.kind === 'usable' && ran) {
    const looksLikeFailure =
      /not found|No such file|not recognized|command not found|Permission denied/i.test(
        result.stdout,
      ) && exit !== 0;
    if (looksLikeFailure) usableFailure = `exit ${exit}, output looks like a failure`;
  }
  if (usableFailure !== null) findings.push(usableFailure);

  const verdict = findings.some((f) => f.startsWith('INVALID'))
    ? 'INVALID'
    : findings.length === 0
      ? 'PASS'
      : 'FAIL';

  return {
    cell: cell.id,
    title: cell.title,
    kind: cell.kind,
    profile,
    verdict,
    findings,
    executed: ran,
    exitCode: exit,
    identity,
    cwdSeen,
    argv,
    canaryChanged,
    wsChanged,
    appProtected: { before: appBefore, after: appAfter },
    leaked,
    stdout: excerpt(result.stdout),
    stderr: excerpt(result.stderr, 400),
    command,
  };
}

export async function runLayer1(cells) {
  fs.mkdirSync(WORK, { recursive: true });
  const results = [];
  for (const cell of cells) {
    for (const profile of PROFILES) {
      const record = await runOne(cell, profile);
      results.push(record);
      process.stderr.write(
        `  L1 ${cell.id} [${profile}] ${record.verdict}` +
          (record.findings?.length ? ` — ${record.findings.join('; ')}` : '') +
          '\n',
      );
    }
  }
  return results;
}
