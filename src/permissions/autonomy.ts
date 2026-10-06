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
    const parsed: unknown = JSON.parse(
      await readFile(settingsPath(atlasHome), 'utf8'),
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'level' in parsed &&
      isAutonomyLevel(parsed.level)
    ) {
      const changedAt = (parsed as { changedAt?: unknown }).changedAt;
      return {
        level: (parsed as { level: AutonomyLevel }).level,
        changedAt: typeof changedAt === 'string' ? changedAt : '',
      };
    }
  } catch {
    // Absent or corrupt: the safe default applies.
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
  await writeFile(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
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

/** Root or the user's home, resolved so `~` and `/` forms cannot slip past. */
function isCatastrophicTarget(
  target: string,
  home: string | undefined,
): boolean {
  const normalized = target.replace(/\/+$/, '') || '/';
  const unexpanded = target.startsWith('~') || target.startsWith('$HOME');
  if (normalized === '/' || normalized === '/*') return true;
  if (unexpanded) return true;
  if (
    home !== undefined &&
    home !== '' &&
    normalized === home.replace(/\/+$/, '')
  ) {
    return true;
  }
  return false;
}

/** Writes that would change Atlas's own gating or safety configuration. */
function isSelfModification(command: string): boolean {
  const patterns = [
    /atlas\.lock/,
    /permissions\.json/,
    /sudoers/,
    /\batlas\.db\b/,
    /autonomy\.json/,
    /risk-classifier|rule-engine|safe-bin-profiles|default-rules/,
  ];
  return patterns.some((pattern) => pattern.test(command));
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
