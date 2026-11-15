// Audit-truthfulness dump (Step 3): groups every audit row the Layer 2 runs
// wrote by outcome type, re-derives each record's outcome from its rows using
// the same vocabulary the harness asserts, and cross-checks the rows embedded
// in the results against the per-cell audit databases read independently.
//
// Run AFTER the matrix: node audit-dump.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = '/home/titan/atlas-evidence-20261113/run';
const EV = `${BASE}/evidence`;

/** Same classification the harness asserts against (layer2.mjs observed()). */
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

const results = [];
for (const f of ['results-layer2.json']) {
  const p = `${EV}/${f}`;
  if (existsSync(p)) results.push(...JSON.parse(readFileSync(p, 'utf8')));
}
// The four per-shadow files, not results-layer2c.json: the loop overwrites
// that one each iteration, so it only ever holds the last shadow.
for (const s of ['missing', 'not-executable', 'userns-denied', 'failing']) {
  const p = `${EV}/results-layer2c-${s}.json`;
  if (existsSync(p)) results.push(...JSON.parse(readFileSync(p, 'utf8')));
}
if (results.length === 0) {
  console.log('NO RESULTS — run the matrix first');
  process.exit(1);
}

const problems = [];
const byOutcome = {};
const byOutcomeFE = {}; // outcome -> `${frontend}/${autonomy}` -> n
const byRowKind = {};
let rowTotal = 0;
let recordsWithoutRows = 0;

for (const r of results) {
  const rows = r.rows ?? [];
  const out = observed(rows);
  byOutcome[out] = (byOutcome[out] ?? 0) + 1;
  const fe = `${r.frontend}/${r.autonomy}`;
  byOutcomeFE[out] = byOutcomeFE[out] ?? {};
  byOutcomeFE[out][fe] = (byOutcomeFE[out][fe] ?? 0) + 1;
  if (rows.length === 0) recordsWithoutRows++;
  if (out !== r.actual) {
    problems.push(`${r.id}: record actual=${r.actual} but re-derived=${out}`);
  }
  if (out.startsWith('unknown:')) {
    problems.push(`${r.id}: outcome vocabulary gap -> ${out}`);
  }
  if (r.expected !== undefined && r.expected !== r.actual) {
    problems.push(`${r.id}: predicted=${r.expected} observed=${r.actual}`);
  }
  for (const row of rows) {
    rowTotal++;
    const k = `${row.decision} | gate=${row.gate_path} | outcome=${row.outcome} | backend=${row.sandbox_backend} | escalated=${row.escalated}`;
    byRowKind[k] = (byRowKind[k] ?? 0) + 1;
    if (row.escalated === 1 || row.escalated === true) {
      problems.push(`${r.id}: a row claims escalated=1`);
    }
  }
}

// Independent cross-check: read each per-cell audit database directly and
// compare with the rows the harness embedded in the results record.
const homeDir = `${BASE}/fakehome`;
let dbCount = 0;
let dbCompared = 0;
if (existsSync(homeDir)) {
  for (const dir of readdirSync(homeDir).filter((d) => d.startsWith('atlas-'))) {
    const dbPath = `${homeDir}/${dir}/atlas.db`;
    if (!existsSync(dbPath)) continue;
    dbCount++;
    const rec = results.find(
      (r) => dir === `atlas-${r.cell}-${r.frontend}-${r.autonomy}`,
    );
    if (!rec) continue;
    let rows = [];
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      rows = db
        .prepare(
          'SELECT decision, gate_path, outcome, sandbox_backend, sandbox_profile, escalated, risk_tier, matched_rule FROM audit_log WHERE command = ? ORDER BY id ASC',
        )
        .all(rec.command);
      db.close();
    } catch (e) {
      problems.push(`${dir}: DB read failed: ${e.message}`);
      continue;
    }
    dbCompared++;
    const key = (x) =>
      `${x.decision}|${x.gate_path}|${x.outcome}|${x.sandbox_backend}|${x.sandbox_profile}|${x.escalated}|${x.risk_tier}|${x.matched_rule}`;
    const emb = (rec.rows ?? []).map(key).join('\n');
    const ind = rows.map(key).join('\n');
    if (emb !== ind) {
      problems.push(`${dir}: embedded rows differ from the audit database`);
    }
  }
}

console.log('# Step 3 audit-truthfulness dump');
console.log(`records: ${results.length} (layer2 + layer2c)`);
console.log(`audit rows: ${rowTotal}; records with no audit row: ${recordsWithoutRows}`);
console.log('');
console.log('## Outcome counts (observed from audit rows, per record)');
for (const [k, v] of Object.entries(byOutcome).sort()) {
  const fePart = Object.entries(byOutcomeFE[k])
    .sort()
    .map(([fe, n]) => `${fe}=${n}`)
    .join(' ');
  console.log(`- ${k}: ${v}   (${fePart})`);
}
console.log('');
console.log('## Audit row kinds (decision | gate_path | outcome | backend)');
for (const [k, v] of Object.entries(byRowKind).sort()) {
  console.log(`- ${v} x ${k}`);
}
console.log('');
console.log(
  `## Independent database cross-check: ${dbCompared}/${dbCount} per-cell audit databases compared with the embedded rows`,
);
console.log('');
if (problems.length === 0) {
  console.log('PROBLEMS: none — every record re-derives its own outcome, no');
  console.log('vocabulary gaps, no prediction mismatches, no escalation claims,');
  console.log('and every embedded row set matches the audit database byte for byte.');
} else {
  console.log(`PROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(`- ${p}`);
}
process.exit(problems.length === 0 ? 0 : 1);
