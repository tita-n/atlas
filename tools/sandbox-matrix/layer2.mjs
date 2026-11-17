/**
 * Layer 2: the real front-ends, driven end to end.
 *
 * What this layer can and cannot prove:
 *   - It proves the REAL gate reached a REAL decision for a REAL tool call, and
 *     that `atlas chat` and `atlas tui` agree.
 *   - It does NOT prove containment. A gate denial means the command never ran,
 *     so there is nothing to observe. Containment is Layer 1's claim.
 *
 * Three rules keep it from going vacuous, all three learned from the previous
 * matrix that reported PASS on 56 cells and tested nothing:
 *   1. A cell with no tool call in the provider log is INVALID, never PASS.
 *   2. The decision is read from the audit DATABASE, not the transcript.
 *   3. The decision is compared against the one the gate's own rules predict,
 *      computed in-process from the classifier and the floor. A cell that
 *      "passes" while disagreeing with the rules is a bug in the harness or the
 *      program, and either way not a pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { hardFloorVerdict, saveAutonomy } from '/app/dist/permissions/autonomy.js';
import { RiskClassifier } from '/app/dist/permissions/risk-classifier.js';

import { excerpt, hashTree, diffTree } from './evidence.mjs';

const TEMPLATE = '/template';
const WORK = '/work';
const CANARY = '/canary';
const FAKEHOME = '/fakehome';
const EVIDENCE = '/evidence';
const CONFIRM_PHRASE = 'ATLAS CONFIRM';
const MESSAGE = 'carry out the requested operation';
const PORT = Number(process.env.MOCK_PORT ?? 21800);

const classifier = new RiskClassifier({ userRules: [], sudoWhitelistInstalled: false });

/** What the code's own rules say should happen, before we look at anything. */
function predict(command, { refusing }) {
  if (refusing) return 'refused-degraded';
  const floor = hardFloorVerdict(command, { home: FAKEHOME });
  if (floor.applies) return 'denied-by-floor';
  const assessment = classifier.assess(command, WORK);
  if (assessment.tier === 1 || assessment.decision === 'deny') return 'denied-by-floor';
  return 'ran-in-sandbox';
}

/** What actually happened, from the audit rows the run wrote. */
function observed(rows) {
  if (rows.length === 0) return 'no-audit-row';
  const row = rows[rows.length - 1];
  if (row.sandbox_backend === 'refusing' || row.gate_path === 'refused-degraded') {
    return 'refused-degraded';
  }
  if (row.gate_path === 'denied-hard-floor' || row.gate_path === 'hard-block') {
    return 'denied-by-floor';
  }
  if (row.decision === 'asked-denied') return 'denied-by-user';
  if (
    ['allowed', 'asked-approved', 'previewed'].includes(row.decision) &&
    row.sandbox_backend === 'bwrap'
  ) {
    return 'ran-in-sandbox';
  }
  return `unknown:${row.decision}/${row.gate_path}/${row.sandbox_backend}`;
}

function findNamed(root, names, depth = 6) {
  const found = [];
  const visit = (dir, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (names.includes(entry.name)) found.push(full);
      if (entry.isDirectory()) visit(full, level + 1);
    }
  };
  visit(root, 0);
  return found;
}

function readRows(home, command) {
  const dbPath = path.join(home, 'atlas.db');
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const stmt = db.prepare(
      'SELECT decision, gate_path, outcome, sandbox_backend, sandbox_profile, escalated, risk_tier, matched_rule FROM audit_log WHERE command = ? ORDER BY id ASC',
    );
    const rows = stmt.all(command);
    db.close();
    return rows;
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return [{ decision: `DB_ERROR:${error?.message ?? error}`, gate_path: null, sandbox_backend: null }];
  }
}

function countToolCalls() {
  try {
    const lines = fs.readFileSync(path.join(EVIDENCE, 'provider.log'), 'utf8').trim().split('\n');
    return lines.filter((line) => {
      try {
        return typeof JSON.parse(line).step?.tool === 'string';
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

async function runChat(cell, key, workspace, home, respond) {
  return await new Promise((resolve) => {
    const child = spawn('node', [path.join(workspace, 'dist', 'cli.js'), 'chat', '--new'], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: FAKEHOME,
        ATLAS_HOME: home,
        ATLAS_SANDBOX_PROFILE: 'workspace-write',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));

    // The child can exit between two 60 ms ticks. A write to its closed stdin
    // then raises EPIPE on a stream with no 'error' listener, and an unhandled
    // 'error' event takes down the entire container - observed for real: the
    // first full matrix died at B19 with 57 Layer 2 runs never written while
    // run.mjs printed a final summary anyway. A write to an already-dead child
    // says nothing about the cell (the audit rows do), so it is absorbed here.
    child.stdin.on('error', () => {});

    let sentMessage = false;
    let confirmSeen = 0;
    let confirmAnswered = 0;
    let exited = false;
    const started = Date.now();

    const timer = setInterval(() => {
      if (exited) return;
      const promptCount = (out.match(/atlas> /g) ?? []).length;
      if (!sentMessage && promptCount >= 1) {
        sentMessage = true;
        child.stdin.write(`${MESSAGE}\n`);
        return;
      }
      const asks = (out.match(/to run it, anything else to cancel/g) ?? []).length;
      if (asks > confirmSeen) {
        confirmSeen = asks;
        confirmAnswered += 1;
        child.stdin.write(respond === 'approve' ? `${CONFIRM_PHRASE}\n` : 'no\n');
        return;
      }
      // Second prompt means the turn is over and the loop is waiting again.
      if (sentMessage && promptCount >= 2 && asks === confirmAnswered) {
        child.stdin.write('/exit\n');
      }
      if (Date.now() - started > 60_000) {
        child.kill('SIGKILL');
      }
    }, 60);

    child.on('close', (code) => {
      exited = true;
      clearInterval(timer);
      resolve({ stdout: out, stderr: err, exit: code });
    });
  });
}

async function runTui(cell, key, workspace, home, respond) {
  // Keystroke timing is a classic flake source. The schedule therefore waits
  // for real state before acting: the composer ready, then the user line, then
  // (only when the run intends an approval, so the gate actually asks) the
  // confirmation modal. Unattended runs never ask by design; a tier-0 command
  // under confirm-everything auto-allows instead of asking. For both no-ask
  // forms the anchored wait is skipped and the presses become the fallback:
  // if the product DOES mount a modal anyway, one of the spaced presses
  // answers it, and if it does not, the keys stay as unsubmitted text.
  const answerKey = respond === 'approve' ? 'y' : 'n';
  const schedule = [
    { wait: 3 },
    { waitFor: 'IDLE', timeout: 12 },
    { send: MESSAGE },
    { wait: 1.2 },
    { send: '\r' },
    { wait: 3 },
    // Self-heal a swallowed submit: an extra Enter only if the turn never
    // started (no 'working' state). If the turn DID start, no key is sent, so
    // a mounted confirmation modal can never be hit by this Enter (its
    // highlighted default is Cancel, Enter would deny).
    { unlessSeen: 'working', send: '\r' },
    ...(respond === 'approve'
      ? [
          // First press anchored on the pending-ask status, after the modal
          // has a moment to mount; then two spaced presses. The modal briefly
          // unmounts to a status-only frame while the tool card redraws, so a
          // single press can land in the composer through that window; spaced
          // repeats always land while the modal is mounted. Unanswered keys
          // stay unsubmitted text. The needle is 'needs your' and NOT the
          // longer phrase because narrow terminals wrap the status between
          // the two words, and a wrapped needle would silently never match.
          {
            waitFor: 'needs your',
            timeout: 15,
            delay: 0.4,
            omit: true,
            send: answerKey,
          },
        ]
      : [{ wait: 1 }]),
    // Reconstructed-harness fix (documented in the remediation report): the
    // original sed that renamed `key` -> `answerKey` only matched `send: key,`
    // (with trailing comma), so these two comma-less fallback presses kept
    // sending the CELL KEY string (e.g. "A16-tui-confirm-everything") instead
    // of the answer. They must send the answer, exactly like the anchored press.
    { send: answerKey },
    { wait: 1.8 },
    { send: answerKey },
    { wait: 8 },
  ];
  return await new Promise((resolve) => {
    const child = spawn(
      'python3',
      ['/harness/pty-run.py', 'node', path.join(workspace, 'dist', 'cli.js'), 'tui', '--new'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: FAKEHOME,
          ATLAS_HOME: home,
          ATLAS_SANDBOX_PROFILE: 'workspace-write',
          PTY_SCHEDULE: JSON.stringify(schedule),
          PTY_QUIET: '2',
          // Reconstructed-harness robustness fix (documented): the TUI emits a
          // ~2.2MB/60s render storm while an ask pends; 60s was too tight for
          // the slowest cells, 90s removes the timeout as a failure source
          // without masking real hangs (a real hang still fails the cell).
          PTY_TIMEOUT: '90',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ stdout: out, stderr: err, exit: code }));
  });
}

export async function runLayer2(plan, { refusing, frontends }) {
  fs.mkdirSync(WORK, { recursive: true });
  const results = [];
  for (const { cell, frontend, autonomy, respond } of plan) {
    if (frontends && !frontends.includes(frontend)) continue;
    const key = `${cell.id}-${frontend}-${autonomy}`;
    const home = path.join(FAKEHOME, `atlas-${key}`);
    const workspace = path.join(WORK, key);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.cpSync(TEMPLATE, workspace, { recursive: true });

    const command = cell.command.replaceAll('@WORK@', workspace);
    const script = cell.script.map((step) =>
      step.tool ? { ...step, args: { command } } : step,
    );
    // A cell runs exactly ONE command. If the scripted provider emitted the raw
    // template the workspace path would not match, so substitute it here.
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      provider: 'openai-compatible',
      apiKey: 'sk-canary-key-must-never-be-readable',
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      model: 'mock',
    }));
    fs.writeFileSync(path.join(home, 'permissions.json'), JSON.stringify({ rules: [], grants: [] }));
    await saveAutonomy(home, autonomy);
    fs.writeFileSync(path.join(EVIDENCE, 'script.json'), JSON.stringify(script));
    fs.writeFileSync(path.join(EVIDENCE, 'provider.log'), '');

    const canaryBefore = hashTree(CANARY);
    const run = frontend === 'tui'
      ? await runTui(cell, key, workspace, home, respond)
      : await runChat(cell, key, workspace, home, respond);
    // The full pty transcript is too big for the results row; keep it verbatim
    // so a failed cell can be replayed against its own raw bytes.
    if (frontend === 'tui') {
      fs.writeFileSync(path.join(EVIDENCE, `tui-${key}.log`), run.stdout);
      fs.writeFileSync(path.join(EVIDENCE, `tui-${key}.stderr`), run.stderr);
    }
    const canaryChanged = diffTree(canaryBefore, hashTree(CANARY));

    const toolCalls = countToolCalls();
    const rows = readRows(home, command);
    const actual = observed(rows);
    const expected = predict(command, { refusing });
    // The cells' own `forbidden` lists are the sentinels: escape markers
    // ('pwned') everywhere, and `failclosed.txt` only where a refusal was
    // expected. A main-body C run executes by design (`expected:
    // ran-in-sandbox`), so flagging the very sentinel its own command writes
    // would fail the cell for doing exactly what it was asked to do -
    // observed: 16 such rows failed before the scan honoured the cell lists.
    const sentinelNames = [...new Set(['pwned', 'pwned.txt', ...(cell.forbidden ?? [])])]
      .filter((name) => refusing || name !== 'failclosed.txt');
    const forbidden = findNamed(workspace, sentinelNames)
      .concat(findNamed(CANARY, sentinelNames))
      .concat(findNamed(FAKEHOME, sentinelNames));
    const leaked = (cell.mustNotLeak ?? []).filter((s) => run.stdout.includes(s));

    const findings = [];
    if (toolCalls < 1) findings.push('INVALID: no tool call was produced');
    if (actual !== expected) findings.push(`decision ${actual} != predicted ${expected}`);
    if (canaryChanged.length > 0) findings.push(`host canaries changed: ${canaryChanged.join(', ')}`);
    if (forbidden.length > 0) findings.push(`forbidden file created: ${forbidden.join(', ')}`);
    if (leaked.length > 0) findings.push(`leaked secret: ${leaked.join(', ')}`);
    if (refusing && !/refusing|SANDBOX UNAVAILABLE|no sandbox is available/i.test(run.stdout)) {
      findings.push('expected a visible refusal, saw none');
    }

    const verdict = findings.some((f) => f.startsWith('INVALID'))
      ? 'INVALID'
      : findings.length === 0
        ? 'PASS'
        : 'FAIL';

    results.push({
      id: `${cell.id}/${frontend}/${autonomy}`,
      cell: cell.id,
      title: cell.title,
      frontend,
      autonomy,
      respond,
      command,
      verdict,
      findings,
      toolCalls,
      expected,
      actual,
      rows,
      exit: run.exit,
      stdout: excerpt(run.stdout, 1200),
      stderr: excerpt(run.stderr, 500),
    });
    process.stderr.write(`  L2 ${cell.id} [${frontend}/${autonomy}] ${verdict} ${actual}\n`);
  }
  return results;
}
