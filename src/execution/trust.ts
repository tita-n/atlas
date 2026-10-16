/**
 * Which directories the user has agreed to let Atlas write in.
 *
 * The problem this solves: `workspace-write` is a real expansion of what a
 * command can destroy, and applying it to every directory the moment Atlas is
 * opened means the safe default is "trust whatever directory someone happened
 * to launch us in". So an unknown directory starts `read-only` and the user is
 * asked once.
 *
 * Two properties this file is careful about:
 *
 *   1. **The record lives outside every mount.** Trust decisions go to Atlas
 *      state, which is not visible inside a sandbox. A trust record the sandbox
 *      can edit is not a trust record.
 *   2. **It carries a digest, exactly like `autonomy.json`.** Writing
 *      `trust.json` by hand is the accident the ceremony exists to catch.
 *
 * **What the digest does and does not detect.** It catches corruption, a
 * partial write, and a naive hand-edit of `trust.json` alone - all verified in
 * `tests/execution/trust-escalation.test.ts`. It does **not** detect an
 * attacker who can write Atlas state at all, because the digest is unkeyed and
 * sits in the same directory as the file it protects: forge the JSON, recompute
 * the digest, and the record is honoured. That is the same limitation
 * `autonomy.ts` has, and the threat model is the same one: *Atlas's own
 * sandbox must not be able to reach Atlas state*, not *a hostile user account
 * must not be able to edit a file it owns*. Anyone who needs the stronger
 * property needs a key Atlas does not have.
 *
 * A hand-edited or corrupt file is treated as "nothing is trusted" rather than
 * as an error. For a record of consent, the safe reading of a broken file is
 * that no consent was given.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

/** One directory the user has agreed to let Atlas write in. */
export interface TrustedDirectory {
  /** Canonical absolute path. Symlinks are resolved before storage. */
  readonly path: string;
  /** ISO timestamp of the decision. */
  readonly trustedAt: string;
}

const trustFileSchema = z.object({
  version: z.literal(1),
  trusted: z.array(
    z.object({
      path: z.string().min(1),
      trustedAt: z.string().datetime(),
    }),
  ),
});

/** Where the trust record lives. Never inside any sandbox mount. */
export function trustPath(atlasHome: string): string {
  return join(atlasHome, 'trust.json');
}

/** Companion digest file, mirroring `autonomy.sha256`. */
export function trustEvidencePath(atlasHome: string): string {
  return join(atlasHome, 'trust.sha256');
}

function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Canonicalises a path before it is stored or compared.
 *
 * Trusting `/home/u/project` and later being asked about `/home/u/project/..`
 * or a symlink to it would be the same decision asked twice, so the record is
 * always the resolved path. Falls back to lexical resolution when the path
 * does not exist yet, which is the case for a directory being trusted as it is
 * created.
 */
export async function canonicalize(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    return await realpath(absolute);
  } catch {
    return resolve(absolute);
  }
}

/**
 * A decision about trust for one directory.
 *
 * `provisional` matters: the FIRST run in an unknown directory has to start
 * read-only and ask, so the value used for that run is not yet backed by a
 * stored record.
 */
export interface TrustDecision {
  readonly trusted: boolean;
  readonly provisional: boolean;
  readonly reason: string;
}

/**
 * Reads the trust record.
 *
 * Returns an empty list for a missing, unreadable, malformed, or tampered
 * file. Every one of those means the same thing operationally: no consent is on
 * record, so nothing is trusted, so everything starts read-only.
 */
export async function loadTrust(atlasHome: string): Promise<TrustedDirectory[]> {
  let raw: string;
  try {
    raw = await readFile(trustPath(atlasHome), 'utf8');
  } catch {
    return [];
  }
  let recorded: string;
  try {
    recorded = (await readFile(trustEvidencePath(atlasHome), 'utf8')).trim();
  } catch {
    return [];
  }
  // Evidence checked BEFORE parsing: a hand-edited file must not be honoured
  // even if it happens to be valid JSON.
  if (recorded !== digestOf(raw)) return [];
  try {
    const parsed = trustFileSchema.parse(JSON.parse(raw));
    return parsed.trusted.map((t) => ({ path: t.path, trustedAt: t.trustedAt }));
  } catch {
    return [];
  }
}

/** Persists the record together with its digest. */
export async function saveTrust(
  atlasHome: string,
  trusted: readonly TrustedDirectory[],
): Promise<void> {
  const body = JSON.stringify(
    { version: 1, trusted: [...trusted] },
    null,
    2,
  );
  await mkdir(atlasHome, { recursive: true });
  await writeFile(trustPath(atlasHome), body, { mode: 0o600 });
  // Deliberately NOT swallowed. If the digest cannot be written, the record is
  // unreadable on the next load (`loadTrust` treats a digest mismatch as "no
  // consent"), so the user's explicit decision would be silently discarded
  // while the CLI printed success. Failing loudly is the honest outcome.
  await writeFile(trustEvidencePath(atlasHome), digestOf(body), {
    mode: 0o600,
  });
}

/**
 * Whether a path is already trusted.
 *
 * The input is canonicalised before comparison. Records are always stored
 * resolved, so comparing a raw input against them would miss a trust decision
 * made through a symlinked or relative spelling of the same directory - and
 * the failure mode of that miss is asking the user again, or worse, starting
 * read-only in a directory they already approved.
 */
export async function isTrusted(
  atlasHome: string,
  path: string,
): Promise<boolean> {
  const canonical = await canonicalize(path);
  const all = await loadTrust(atlasHome);
  return all.some((t) => t.path === canonical);
}

/**
 * Records consent for one directory. Idempotent.
 *
 * Canonicalises internally rather than trusting the caller. When `isTrusted`
 * resolved its input and the mutators did not, a record stored as
 * `/work/../work2` could never be withdrawn by `forgetTrust('/work2')` - and a
 * trust entry the user cannot revoke is worse than no consent record at all.
 */
export async function rememberTrust(
  atlasHome: string,
  path: string,
  now: Date = new Date(),
): Promise<TrustedDirectory[]> {
  const canonical = await canonicalize(path);
  // Refused here, not only in the CLI, so every caller inherits the guard.
  // A trust record for `/` is not "a workspace"; combined with a cwd of `/` it
  // is the request that would make the whole host writable.
  if (canonical === '/') {
    throw new Error(
      'refusing to trust / : that is every directory, not a workspace',
    );
  }
  const all = await loadTrust(atlasHome);
  const next = all.some((t) => t.path === canonical)
    ? all
    : [...all, { path: canonical, trustedAt: now.toISOString() }];
  await saveTrust(atlasHome, next);
  return next;
}

/** Withdraws consent for one directory. Canonicalises, as rememberTrust does. */
export async function forgetTrust(
  atlasHome: string,
  path: string,
): Promise<TrustedDirectory[]> {
  const canonical = await canonicalize(path);
  const all = await loadTrust(atlasHome);
  const next = all.filter((t) => t.path !== canonical);
  await saveTrust(atlasHome, next);
  return next;
}

/** Parent of a path, for the "trust this instead" prompt. */
export function parentOf(canonicalPath: string): string | undefined {
  const parent = dirname(canonicalPath);
  return parent === canonicalPath ? undefined : parent;
}
