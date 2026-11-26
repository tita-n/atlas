/**
 * Autonomy levels: how often the gate asks for a human.
 *
 * This owns only the risk *tradeoff*, never the notion of danger. Classification
 * is untouched: what Atlas considers dangerous is decided by the existing rule
 * engine, and this module decides whether a person is asked about it.
 *
 * Three levels, from most to least supervised:
 *
 *   confirm-everything  every dangerous action asks individually. The default,
 *                       so nothing about Atlas changes until a user chooses to.
 *   scoped-approval     a declared scope of categories is approved once, then
 *                       the task proceeds without per-command stalling.
 *   unattended          nothing asks, except the hard floor below.
 *
 * The hard floor is not a safety override of the user's choice. It is a
 * separate, deliberately tiny category: actions whose damage is unrecoverable
 * rather than merely expensive. Nothing in this file can widen it, and a level
 * of `unattended` cannot switch it off.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type AutonomyLevel =
  'confirm-everything' | 'scoped-approval' | 'unattended';

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  'confirm-everything',
  'scoped-approval',
  'unattended',
];

/** The level Atlas starts in. Changing this would be a safety regression. */
/**
 * Why a self-modification always needs a person.
 *
 * Kept beside the hard floor because it is enforced the same way: structurally,
 * reading no level and no setting. A setting that could be flipped eventually
 * would be flipped by habit.
 */
export const SELF_MODIFICATION_REASON =
  'Atlas is changing its own code. This needs a person every time, at any ' +
  'autonomy level, because a bad self-modification can affect every later ' +
  'decision rather than just this one.';

/**
 * Whether a self-modification always requires human approval.
 *
 * Takes no arguments on purpose: there is no input through which a caller could
 * ask for the exemption to be skipped.
 */
export function selfModificationAlwaysAsks(): boolean {
  return true;
}

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'confirm-everything';

export interface AutonomySettings {
  readonly level: AutonomyLevel;
  /** ISO timestamp of when the level was last changed. */
  readonly changedAt: string;
}

/** Human-readable cost of each level, shown before anyone lowers it. */
export interface LevelDescription {
  readonly level: AutonomyLevel;
  readonly label: string;
  readonly risk: string;
  /** Only the default level may be set without deliberate friction. */
  readonly requiresFriction: boolean;
}

export const LEVEL_DESCRIPTIONS: readonly LevelDescription[] = [
  {
    level: 'confirm-everything',
    label: 'Confirm everything',
    risk: 'You approve each dangerous action individually. Nothing changes by default.',
    requiresFriction: false,
  },
  {
    level: 'scoped-approval',
    label: 'Scoped approval',
    risk:
      'You approve a declared set of categories once, then Atlas works through ' +
      'the task without stopping. Anything outside that scope still pauses.',
    requiresFriction: true,
  },
  {
    level: 'unattended',
    label: 'Unattended',
    risk:
      'Atlas runs without asking. Anything it gets wrong is yours to undo. Only ' +
      'unrecoverable actions (wiping a disk, deleting a home directory, editing ' +
      "Atlas's own safety rules) still stop for you.",
    requiresFriction: true,
  },
];

/** Used only if a level is somehow not in the table; keeps this total. */
const FALLBACK_DESCRIPTION: LevelDescription = {
  level: 'confirm-everything',
  label: 'Confirm everything',
  risk: 'You approve each dangerous action individually.',
  requiresFriction: false,
};

export function describeLevel(level: AutonomyLevel): LevelDescription {
  const found = LEVEL_DESCRIPTIONS.find((entry) => entry.level === level);
  // The default level always exists, so this cannot be undefined in practice.
  return found ?? { ...FALLBACK_DESCRIPTION };
}

/** The phrase a user must type to accept a lower-risk setting. */
export function confirmationPhraseFor(level: AutonomyLevel): string {
  return level === 'unattended'
    ? 'I ACCEPT UNATTENDED'
    : 'I ACCEPT SCOPED APPROVAL';
}

export function settingsPath(atlasHome: string): string {
  return join(atlasHome, 'autonomy.json');
}

/** Companion file holding the digest of a legitimately written settings file. */
export function tamperEvidencePath(atlasHome: string): string {
  return join(atlasHome, 'autonomy.sha256');
}

/**
 * Digest of a settings file.
 *
 * The ceremony in the `autonomy` command is only meaningful if there is
 * something to detect when it was skipped. Without this, writing autonomy.json
 * by hand - a script, a dotfile manager, an earlier session - sets unattended
 * with no ceremony at all, which is exactly the hole this closes.
 */
function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Records the digest for a settings file we just wrote through the ceremony. */
async function writeTamperEvidence(
  atlasHome: string,
  raw: string,
): Promise<void> {
  try {
    await writeFile(tamperEvidencePath(atlasHome), digestOf(raw), {
      mode: 0o600,
    });
  } catch {
    // Evidence that cannot be written is not fatal here; the settings file is
    // still written and the next load fails safe.
  }
}

/**
 * Whether a settings file carries matching ceremony evidence.
 *
 * The default level needs no ceremony, so absent evidence is fine. A lowered
 * level is only honoured when its digest matches - otherwise the loader falls
 * back to full confirmation.
 */
async function hasValidEvidence(
  atlasHome: string,
  raw: string,
  level: AutonomyLevel,
): Promise<boolean> {
  if (level === DEFAULT_AUTONOMY_LEVEL) return true;
  let recorded: string;
  try {
    recorded = (await readFile(tamperEvidencePath(atlasHome), 'utf8')).trim();
  } catch {
    return false;
  }
  return recorded === digestOf(raw);
}

/**
 * Loads the persisted level.
 *
 * A missing or unreadable file means the default. Failing open here would be
 * the worst possible default for a safety setting, so anything unparseable
 * resolves to full confirmation.
 */
export async function loadAutonomy(
  atlasHome: string,
): Promise<AutonomySettings> {
  try {
    const raw = await readFile(settingsPath(atlasHome), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'level' in parsed &&
      isAutonomyLevel(parsed.level)
    ) {
      // A lowered level is only honoured with matching ceremony evidence.
      // Otherwise the file was written by something that skipped the ceremony,
      // and the reduction is refused.
      if (!(await hasValidEvidence(atlasHome, raw, parsed.level))) {
        return { level: DEFAULT_AUTONOMY_LEVEL, changedAt: '' };
      }
      const changedAt = (parsed as { changedAt?: unknown }).changedAt;
      return {
        level: parsed.level,
        changedAt: typeof changedAt === 'string' ? changedAt : '',
      };
    }
  } catch {
    // Absent or corrupt: the safe default applies.
  }
  return { level: DEFAULT_AUTONOMY_LEVEL, changedAt: '' };
}

/**
 * Reads the level synchronously, for the per-command decision path.
 *
 * The gate must see a level change immediately rather than at next startup:
 * someone who lowers it in another terminal, or via /autonomy in the same
 * session, is expecting it to take effect now. A cached value read once at
 * construction silently ignored the change and kept prompting, which reads as
 * "the setting does nothing". Fails safe on any problem, like the async path.
 */
export function readAutonomySync(atlasHome: string): AutonomySettings {
  try {
    const raw = readFileSync(settingsPath(atlasHome), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'level' in parsed &&
      isAutonomyLevel(parsed.level)
    ) {
      if (!evidenceMatchesSync(atlasHome, raw, parsed.level)) {
        return { level: DEFAULT_AUTONOMY_LEVEL, changedAt: '' };
      }
      const changedAt = (parsed as { changedAt?: unknown }).changedAt;
      return {
        level: parsed.level,
        changedAt: typeof changedAt === 'string' ? changedAt : '',
      };
    }
  } catch {
    // Absent or unreadable: the safe default applies.
  }
  return { level: DEFAULT_AUTONOMY_LEVEL, changedAt: '' };
}

/** Persists the level. Callers are responsible for the friction ceremony. */
export async function saveAutonomy(
  atlasHome: string,
  level: AutonomyLevel,
  now: string = new Date().toISOString(),
): Promise<AutonomySettings> {
  const settings: AutonomySettings = { level, changedAt: now };
  const path = settingsPath(atlasHome);
  await mkdir(dirname(path), { recursive: true });
  const raw = JSON.stringify(settings, null, 2);
  // Write the evidence first: a settings file that lands without it is treated
  // as untampered-but-unproven and falls back to full confirmation.
  await writeTamperEvidence(atlasHome, raw);
  await writeFile(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}

/** Synchronous evidence check, for the cache-only path. */
function evidenceMatchesSync(
  atlasHome: string,
  raw: string,
  level: AutonomyLevel,
): boolean {
  if (level === DEFAULT_AUTONOMY_LEVEL) return true;
  try {
    return (
      readFileSync(tamperEvidencePath(atlasHome), 'utf8').trim() ===
      digestOf(raw)
    );
  } catch {
    return false;
  }
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return (
    typeof value === 'string' &&
    (AUTONOMY_LEVELS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ *
 * The hard floor
 * ------------------------------------------------------------------ */

/**
 * Actions that always require confirmation, whatever the level.
 *
 * Tier 1 rules already deny outright, which is stronger than asking. This
 * predicate exists as a second, explicit line of defence for the two categories
 * the level must never be able to wave through: unrecoverable destruction, and
 * edits to Atlas's own safety configuration.
 */
export interface HardFloorVerdict {
  readonly applies: boolean;
  readonly category?: 'unrecoverable-destruction' | 'self-modification';
  readonly reason?: string;
}

/**
 * Whether a deletion target is a filesystem root, the home directory, or an
 * ancestor/dot-path/glob form of either.
 *
 * Written to resist *spellings*, not just values. A plain equality check
 * against the home path is defeated by the same intent expressed as
 * `~/*`, `/home/me/.` or `/home/me/..`, which are all catastrophic deletions
 * that read differently but destroy exactly as much.
 */
function isCatastrophicTarget(
  target: string,
  home: string | undefined,
): boolean {
  const raw = target.trim();
  if (raw === '') return false;

  // The home ROOT, however spelled, is catastrophic. A specific subdirectory
  // is not - `rm -rf ~/Downloads/foo` is ordinary cleanup and must ask rather
  // than be refused outright.
  const withoutSlash = raw.replace(/\/+$/, '');
  if (withoutSlash === '~' || withoutSlash === '$HOME') return true;
  // A glob that stands for everything in the home directory.
  if (/^~(\/\*|\/\.\*)?$/.test(withoutSlash)) return true;
  if (/^\$HOME(\/\*|\/\.\*)?$/.test(withoutSlash)) return true;

  const hasGlob = /[*?]/.test(raw);

  // Peel trailing glob and dot-segments: `/*`, `/.`, `/..`, and combinations.
  let path = raw.replace(/\/+$/, '');
  let previous: string;
  do {
    previous = path;
    path = path
      .replace(/\/\*$/, '')
      .replace(/\/\.$/, '')
      .replace(/\/\.\.$/, '');
  } while (path !== previous && path !== '');

  // Peeling can consume the whole path (as in `/..`), which is the root.
  if (path === '' || path === '/') return true;

  if (home === undefined || home === '') return false;
  const resolvedHome = home.replace(/\/+$/, '');
  if (resolvedHome === '') return false;

  // The home directory itself, however it was spelled.
  if (path === resolvedHome) return true;
  // An ancestor of home: wiping `/home` takes every home with it.
  if (resolvedHome.startsWith(`${path}/`)) return true;
  // A glob that covers the whole home tree, e.g. `rm -rf ~/*`.
  if (hasGlob && path === resolvedHome) return true;
  // A glob that covers home, such as `/home/*`.
  if (hasGlob && resolvedHome.startsWith(path)) return true;

  return false;
}

/** Writes that would change Atlas's own gating or safety configuration. */
function isSelfModification(command: string): boolean {
  // Literal names, but also the ways a command can name them without spelling
  // them out: a glob covering the atlas home, a find that deletes every file
  // under it, or a variable standing in for the directory.
  const patterns = [
    /atlas\.lock/,
    /permissions\.json/,
    /sudoers/,
    /\batlas\.db\b/,
    /autonomy\.json/,
    /risk-classifier|rule-engine|safe-bin-profiles|default-rules/,
    /\*\.db\b/,
    /\.atlas/,
    /\$\{?ATLAS_HOME\}?/i,
    /\$HOME\/\.atlas/,
  ];
  if (!patterns.some((pattern) => pattern.test(command))) return false;
  // A mutation, not a read. `ls ~/.atlas` is inspection, not tampering.
  return /\b(rm|unlink|shred|truncate|dd|mv|cp|tee|chmod|chown|install|find|ln|sed|truncate|printf|echo|rsync)\b/.test(
    command,
  );
}

/**
 * Decides whether the hard floor applies to a command.
 *
 * Deliberately narrow. Anything added here permanently stops for a human even
 * in unattended mode, so a catch-all like "destructive command" would quietly
 * turn unattended back into confirm-everything.
 */
export function hardFloorVerdict(
  command: string,
  options: {
    readonly home?: string | undefined;
    readonly tier?: number | undefined;
  } = {},
): HardFloorVerdict {
  const text = command.trim();
  if (text === '') return { applies: false };

  if (isSelfModification(text)) {
    return {
      applies: true,
      category: 'self-modification',
      reason:
        "This would change Atlas's own permission or safety configuration, " +
        'which no autonomy level may authorize automatically.',
    };
  }

  // Recursive force deletion aimed at a root or home scope.
  if (/\brm\b/.test(text) && /(-[a-zA-Z]*r|-[a-zA-Z]*f)/.test(text)) {
    const targets = text
      .replace(/^\s*rm\s+/, '')
      .split(/\s+/)
      .filter((token) => !token.startsWith('-'));
    if (targets.some((target) => isCatastrophicTarget(target, options.home))) {
      return {
        applies: true,
        category: 'unrecoverable-destruction',
        reason:
          'This deletes a filesystem root or a home directory, which cannot ' +
          'be undone.',
      };
    }
  }

  // Raw writes to whole devices.
  if (/\b(mkfs(\.\w+)?|fdisk|parted|shred|wipefs)\b/.test(text)) {
    return {
      applies: true,
      category: 'unrecoverable-destruction',
      reason: 'This writes to a storage device, destroying its contents.',
    };
  }
  if (text.includes('dd') && text.includes('of=/dev/')) {
    return {
      applies: true,
      category: 'unrecoverable-destruction',
      reason: 'This writes directly to a block device.',
    };
  }

  return { applies: false };
}

/**
 * Whether the gate must ask for this command at the given level.
 *
 * The hard floor is evaluated first and unconditionally, so no level can skip
 * it. `scoped-approval` is treated as asking for anything not in its declared
 * scope, which keeps the undeclared case safe by default.
 */
export function shouldAsk(input: {
  readonly level: AutonomyLevel;
  readonly tier: number;
  readonly command: string;
  readonly home?: string | undefined;
  readonly scopedCategories?: readonly string[] | undefined;
  readonly category?: string | undefined;
}): boolean {
  if (hardFloorVerdict(input.command, { home: input.home }).applies)
    return true;
  if (input.level === 'confirm-everything') return true;
  if (input.level === 'unattended') return false;
  // Scoped: ask for anything outside the approved categories, and for
  // anything whose category could not be determined. Treating an unknown
  // category as in-scope would silently wave through exactly the commands
  // nobody thought to classify.
  const scope = input.scopedCategories ?? [];
  if (scope.length === 0) return true;
  if (input.category === undefined) return true;
  return !scope.includes(input.category);
}
