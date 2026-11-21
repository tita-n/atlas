/**
 * The deliberate-friction ceremony for running with no sandbox at all.
 *
 * `full-access` is the one mode where Atlas's text-based safety checks are the
 * ONLY thing between a model and the machine, and those checks are a best-effort
 * heuristic that is known to be bypassable (a base64 pipe, a `cd` the text does
 * not show). It must therefore never be reachable by accident - not by an
 * environment variable someone exports once and forgets, and not as a silent
 * fallback when a sandbox is unavailable (that fallback is now the refusing
 * state; see `refusing-environment.ts`).
 *
 * Two properties, mirroring `trust.ts`:
 *
 *   1. **A typed phrase.** Enabling it means typing `I ACCEPT NO SANDBOX` at a
 *      terminal. That is friction on purpose: it is the difference between
 *      choosing the mode and inheriting it.
 *   2. **A tamper-evident record.** The decision is written to Atlas state with
 *      an unkeyed digest, outside every mount. A hand-edited `full-access.json`
 *      - or one written by a sandboxed command, if the mask ever failed - is
 *      treated as "not enabled".
 *
 * **What the digest does and does not detect** is the same caveat `trust.ts`
 * carries: it catches corruption, a partial write, and a naive hand-edit; it
 * does not stop someone who can already write Atlas state from forging a fresh
 * digest. The threat model is "Atlas's own sandbox must not reach Atlas state",
 * not "a hostile local account".
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

/** The phrase the user must type verbatim. Kept here so every surface agrees. */
export const FULL_ACCESS_PHRASE = 'I ACCEPT NO SANDBOX';

const recordSchema = z.object({
  version: z.literal(1),
  enabled: z.literal(true),
  enabledAt: z.string().datetime(),
});

export interface FullAccessRecord {
  readonly enabled: true;
  readonly enabledAt: string;
}

/** Where the record lives. Never inside any sandbox mount. */
export function fullAccessPath(atlasHome: string): string {
  return join(atlasHome, 'full-access.json');
}

/** Companion digest file, mirroring `trust.sha256` and `autonomy.sha256`. */
export function fullAccessEvidencePath(atlasHome: string): string {
  return join(atlasHome, 'full-access.sha256');
}

function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Reads the record, or null when full access is not enabled.
 *
 * A missing, unreadable, malformed, or tampered record all mean the same thing
 * operationally: no consent is on record, so the mode is off.
 */
export async function loadFullAccessGrant(
  atlasHome: string,
): Promise<FullAccessRecord | null> {
  let raw: string;
  try {
    raw = await readFile(fullAccessPath(atlasHome), 'utf8');
  } catch {
    return null;
  }
  let recorded: string;
  try {
    recorded = (await readFile(fullAccessEvidencePath(atlasHome), 'utf8')).trim();
  } catch {
    return null;
  }
  // Evidence checked BEFORE parsing: a hand-edited file must not be honoured
  // even if it happens to be valid JSON.
  if (recorded !== digestOf(raw)) return null;
  try {
    const parsed = recordSchema.parse(JSON.parse(raw));
    return { enabled: true, enabledAt: parsed.enabledAt };
  } catch {
    return null;
  }
}

/**
 * Enables full access, but only for the exact phrase.
 *
 * Throws on a wrong phrase rather than returning a boolean, so a caller cannot
 * accidentally treat the failure as success by ignoring a return value.
 */
export async function enableFullAccess(
  atlasHome: string,
  phrase: string,
  now: Date = new Date(),
): Promise<FullAccessRecord> {
  if (phrase.trim() !== FULL_ACCESS_PHRASE) {
    throw new Error(
      `refusing to enable full access: the confirmation phrase must be exactly "${FULL_ACCESS_PHRASE}"`,
    );
  }
  const record: FullAccessRecord = {
    enabled: true,
    enabledAt: now.toISOString(),
  };
  const body = JSON.stringify({ version: 1, ...record }, null, 2);
  await mkdir(atlasHome, { recursive: true });
  await writeFile(fullAccessPath(atlasHome), body, { mode: 0o600 });
  // Not swallowed: if the digest cannot be written the record reads as "off" on
  // the next load, so printing success here would be a lie.
  await writeFile(fullAccessEvidencePath(atlasHome), digestOf(body), {
    mode: 0o600,
  });
  return record;
}

/** Removes the record. Idempotent; both files go. */
export async function disableFullAccess(atlasHome: string): Promise<void> {
  await rm(fullAccessPath(atlasHome), { force: true });
  await rm(fullAccessEvidencePath(atlasHome), { force: true });
}
