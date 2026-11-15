/**
 * Shared evidence helpers.
 *
 * Every recorded claim in this harness is backed by bytes: a sha256 before and
 * after, a START/END marker pair, an exit code, an audit row. Prose is never
 * evidence, so nothing here returns a boolean without also returning the raw
 * material that produced it.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

export const START = 'ATLAS_L1_START';
export const END = 'ATLAS_L1_END';
export const ID = 'ATLAS_L1_ID';
export const ROOTWRITE = 'ATLAS_L1_ROOTWRITE';
export const PWD = 'ATLAS_L1_PWD';

/** Parses the in-sandbox identity line. */
export function sandboxIdentity(stdout) {
  const idMatch = new RegExp(`${ID} NNP=(\\S+) CAPEFF=(\\S+)`).exec(stdout);
  const rootMatch = new RegExp(`${ROOTWRITE} (\\S+)`).exec(stdout);
  return {
    noNewPrivs: idMatch?.[1] ?? null,
    capEff: idMatch?.[2] ?? null,
    rootWritable: rootMatch?.[1] ?? null,
  };
}

export function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch (error) {
    return `MISSING:${error?.code ?? error?.message ?? 'error'}`;
  }
}

/** Every regular file under `root`, as a sorted relative-path → sha map. */
export function hashTree(root) {
  const out = {};
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out[path.relative(root, full)] = sha256File(full);
    }
  };
  visit(root);
  return out;
}

/** Relative paths whose hash changed (or appeared) between two tree hashes. */
export function diffTree(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

/** Wraps a command so its execution is visible even if it exits nonzero. */
export function mark(command) {
  return [
    // Proof that the command really ran INSIDE the sandbox, printed by the
    // command itself. Without this, a command that ran in the outer container
    // would look identical to one that ran in the inner sandbox, and the whole
    // layer would be reporting on a boundary it never crossed.
    `printf '${ID} NNP=%s CAPEFF=%s\\n' "$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)" "$(awk '/^CapEff:/{print $2}' /proc/self/status)"`,
    // And that `/` is not writable, which is what makes the destructive cells
    // safe rather than merely unlucky.
    `if touch /atlas-root-probe 2>/dev/null; then printf '${ROOTWRITE} yes\\n'; rm -f /atlas-root-probe; else printf '${ROOTWRITE} no\\n'; fi`,
    // And where the shell actually is, since a `cd /` at the start of a cell
    // relocates it and every relative target in that cell silently changes
    // meaning. Recorded, not asserted: the cells own their cwd.
    `printf '${PWD}_REL=%s\\n' "$PWD"`,
    `printf '${START}\\n'`,
    `{ ${command} ; } 2>&1`,
    `atlas_rc=$?`,
    `printf '\\n${END}:%s\\n' "$atlas_rc"`,
  ].join('\n');
}

export function executed(stdout) {
  return stdout.includes(START) && stdout.includes(`${END}:`);
}

export function cwdOf(stdout) {
  const m = new RegExp(`${PWD}_REL=(.+)`).exec(stdout);
  return m ? m[1].trim() : null;
}

export function exitFrom(stdout) {
  const match = new RegExp(`${END}:(\\d+)`).exec(stdout);
  return match ? Number(match[1]) : null;
}

export function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** First `n` characters, with a marker so truncation is never mistaken for a blank. */
export function excerpt(text, n = 900) {
  const trimmed = text.replace(/\r/g, '');
  return trimmed.length <= n ? trimmed : `${trimmed.slice(0, n)}…[+${trimmed.length - n}]`;
}
