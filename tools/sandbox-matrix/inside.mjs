/**
 * Entry point that runs INSIDE the outer bwrap container.
 *
 * The host orchestrator (`run.mjs`) never invokes a front-end directly. It
 * builds a disposable world, drops this file into a nested bubblewrap, and the
 * work happens there - so a bug in the harness, or a command that escapes its
 * inner sandbox, still cannot reach the real repository or the real home.
 *
 * Usage: node inside.mjs <layer1|layer2|layer2c>
 */

import * as fs from 'node:fs';

import { A_CELLS, B_CELLS, C_CELLS, D_CELLS, LAYER1_CELLS, layer2Plan } from './cells.mjs';
import { runLayer1 } from './layer1.mjs';
import { runLayer2 } from './layer2.mjs';

const EVIDENCE = '/evidence';

function list(name) {
  const value = process.env[name];
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

const mode = process.argv[2];

function writeResults(name, results) {
  const target = `${EVIDENCE}/results-${name}.json`;
  fs.writeFileSync(target, JSON.stringify(results, null, 2));
  const verdicts = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  process.stderr.write(`wrote ${target}: ${JSON.stringify(verdicts)}\n`);
}

if (mode === 'layer1') {
  const suites = list('L1_SUITES');
  const ids = list('L1_IDS');
  let cells = LAYER1_CELLS.filter((cell) => !suites || suites.includes(cell.id[0]));
  if (ids) cells = cells.filter((cell) => ids.includes(cell.id));
  process.stderr.write(`layer1: ${cells.length} cells x 2 profiles\n`);
  writeResults('layer1', await runLayer1(cells));
} else if (mode === 'layer2' || mode === 'layer2c') {
  const suites = list('L2_SUITES') ?? [];
  const frontends = list('L2_FRONTENDS');
  const autonomies = list('L2_AUTONOMY');
  const ids = list('L2_IDS');
  let plan = layer2Plan();
  if (mode === 'layer2c') {
    const cids = list('L2_CIDS');
    plan = plan.filter((entry) => C_CELLS.includes(entry.cell));
    if (cids) plan = plan.filter((entry) => cids.includes(entry.cell.id));
  } else if (suites.length > 0) {
    plan = plan.filter((entry) => suites.includes(entry.cell.id[0]));
  }
  if (ids) plan = plan.filter((entry) => ids.includes(entry.cell.id));
  if (frontends) plan = plan.filter((entry) => frontends.includes(entry.frontend));
  if (autonomies) plan = plan.filter((entry) => autonomies.includes(entry.autonomy));
  process.stderr.write(`layer2 (${mode}): ${plan.length} runs\n`);
  writeResults(mode, await runLayer2(plan, { refusing: mode === 'layer2c' }));
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}

// Referenced so eslint/tsc-less tooling does not consider the imports dead in
// the suite-filtering branch above.
void A_CELLS;
void B_CELLS;
void D_CELLS;
