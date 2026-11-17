// Generates the Layer 1 markdown table (61 cells x 2 profiles) from the final
// results file. Run AFTER the matrix:
//   node l1-table.mjs > layer1-table.md
// Companion to l2-table.mjs; same input root, same tally-first shape, so the
// report can paste both without hand-counting anything.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const EV = '/home/titan/atlas-evidence-20261113/run/evidence';
const rows = existsSync(`${EV}/results-layer1.json`)
  ? JSON.parse(readFileSync(`${EV}/results-layer1.json`, 'utf8'))
  : [];

const tally = (keyFn) =>
  rows.reduce((a, r) => {
    const k = keyFn(r);
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {});

const cell = (r) => `\`${r.cell}\``;
const executed = (r) => (r.executed ? `exit ${r.exitCode}` : 'not executed');
// Titles may contain a literal `|` (A07: "base64 | bash payload"); unescaped
// it would split the cell in the rendered table.
const esc = (s) => String(s).replaceAll('|', '\\|');
const findings = (r) =>
  r.findings.length ? r.findings.map(esc).join('; ') : '—';

const row = (r) =>
  `| ${cell(r)} | ${esc(r.title)} | ${r.profile} | **${r.verdict}** | ${executed(
    r,
  )} | ${findings(r)} |`;

const out = [];
out.push(`Layer 1 runs: ${rows.length}`);
out.push(`verdicts: ${JSON.stringify(tally((r) => r.verdict))}`);
out.push(`profiles: ${JSON.stringify(tally((r) => r.profile))}`);
out.push(
  `records not executed: ${rows.filter((r) => !r.executed).length}`,
);
out.push(
  `records with findings: ${rows.filter((r) => r.findings.length > 0).length}`,
);
out.push('');
out.push('| cell | title | profile | verdict | executed | findings |');
out.push('|---|---|---|---|---|---|');
out.push(...rows.map(row));

const md = out.join('\n');
writeFileSync('/home/titan/atlas/tools/sandbox-matrix/results/layer1-table.md', md);
console.log(md);
