// Generates the Layer 2 markdown tables (main matrix + C-shadow refusals)
// from the final results files. Run AFTER the matrix:
//   node l2-table.mjs > layer2-table.md
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const EV = '/home/titan/atlas-evidence-20261113/run/evidence';
const main = existsSync(`${EV}/results-layer2.json`)
  ? JSON.parse(readFileSync(`${EV}/results-layer2.json`, 'utf8'))
  : [];
const shadows = ['missing', 'not-executable', 'userns-denied', 'failing']
  .map((s) => `${EV}/results-layer2c-${s}.json`)
  .filter(existsSync)
  .flatMap((p) => JSON.parse(readFileSync(p, 'utf8')));

const row = (r) =>
  `| ${r.cell} | ${r.frontend} | ${r.autonomy} | ${r.respond} | ${r.verdict} | ${r.toolCalls} | ${r.expected} | ${r.actual} | ${r.findings.join('; ') || '—'} |`;

const header = [
  '| cell | front-end | autonomy | provider respond | verdict | calls | predicted | observed | findings |',
  '|---|---|---|---|---|---|---|---|---|',
];

const tally = (rows, keyFn) =>
  rows.reduce((a, r) => {
    const k = keyFn(r);
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {});

const out = [];
out.push(`main Layer 2 runs: ${main.length}`);
out.push(`verdicts: ${JSON.stringify(tally(main, (r) => r.verdict))}`);
out.push(
  `outcomes: ${JSON.stringify(tally(main, (r) => r.actual))}`,
);
out.push(
  `INVALID rows: ${main.filter((r) => r.verdict === 'INVALID').length}`,
);
out.push(
  `records with <1 tool call: ${main.filter((r) => (r.toolCalls ?? 0) < 1).length}`,
);
out.push('');
out.push('parity (outcome counts per front-end/autonomy):');
const parity = tally(main, (r) => `${r.frontend}/${r.autonomy} -> ${r.actual}`);
for (const [k, v] of Object.entries(parity).sort()) out.push(`- ${k}: ${v}`);
out.push('');
out.push(...header, ...main.map(row));
out.push('');
out.push(`C-shadow runs (bwrap unusable): ${shadows.length}`);
out.push(`verdicts: ${JSON.stringify(tally(shadows, (r) => r.verdict))}`);
out.push(`outcomes: ${JSON.stringify(tally(shadows, (r) => r.actual))}`);
out.push('');
out.push(...header, ...shadows.map(row));

const md = out.join('\n');
writeFileSync('/home/titan/atlas/tools/sandbox-matrix/results/layer2-table.md', md);
console.log(md);
