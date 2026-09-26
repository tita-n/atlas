import { homedir } from 'node:os';
import type { PermissionRule, RiskTier } from './rules.schema.js';
import { sudoersRuleExists } from './sudoers-setup.js';
import { DEFAULT_PERMISSION_RULES, HARD_DENY_RULES } from './default-rules.js';
import { RuleEngine, type RuleEvaluation } from './rule-engine.js';
import {
  extractParsedShellStructure,
  extractShellStructure,
  type ShellCommandSegment,
} from './shell-structure.js';
import { isSafeBinSegment } from './safe-bin-profiles.js';
import type { GrantMatcher } from './grant-store.js';
import type { ParsedScript } from 'unbash';

const SAFE_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const SAFE_INSTALL_FLAGS = new Set(['-y', '--assumeyes', '--refresh']);
const SHELL_META_CHARACTERS = /[;&|<>`$()\\]/;
const DANGEROUS_INSTALL_MARKERS = [
  '--nogpgcheck',
  '.rpm',
  'http://',
  'https://',
  'file://',
  '--repofrompath',
  '--setopt',
];

/** Complete permission decision for one command. */
export interface RiskAssessment {
  /** Numeric risk tier. */
  tier: RiskTier;
  /** Effective harness action. */
  decision: 'allow' | 'ask' | 'deny';
  /** Rule that produced the decision, or the implicit Tier 0 rule. */
  matchedRule: PermissionRule;
  /** Plain-language reason safe for the user interface. */
  reason: string;
  /** Whether this command requires the typed confirmation stub. */
  requiresConfirmation: boolean;
  /** Whether this sudo command still needs the explicit setup flow. */
  sudoSetupRequired: boolean;
}

const DEFAULT_ALLOW_RULE: PermissionRule = {
  id: 'default-tier-0',
  pattern: '*',
  decision: 'allow',
  tier: 0,
  description: 'Routine command with no matching higher-risk rule.',
};

const SAFE_DNF_RULE: PermissionRule = {
  id: 'preapproved-dnf-package-command',
  pattern: 'sudo dnf install <safe-package>',
  decision: 'allow',
  tier: 0,
  description: 'Pre-approved package management command.',
};

const SUDO_RULE: PermissionRule = {
  id: 'ask-sudo',
  pattern: 'sudo **',
  decision: 'ask',
  tier: 2,
  description: 'Most sudo commands require explicit confirmation.',
};

const SUDO_SETUP_RULE: PermissionRule = {
  id: 'sudo-package-setup-required',
  pattern: 'sudo dnf install <safe-package>',
  decision: 'ask',
  tier: 2,
  description: 'Passwordless package management setup is not installed.',
};

const SYSTEM_PERMISSION_RULE: PermissionRule = {
  id: 'ask-system-permission-change',
  pattern: 'chmod ** /**',
  decision: 'ask',
  tier: 2,
  description:
    'Changing permissions on an absolute system path requires confirmation.',
};

const FILE_WRITE_RULE: PermissionRule = {
  id: 'info-shell-redirect',
  pattern: '* > **',
  decision: 'allow',
  tier: 3,
  description: 'Shell redirection may overwrite an existing file.',
};

const UNKNOWN_COMMAND_RULE: PermissionRule = {
  id: 'ask-unknown-command',
  pattern: '*',
  decision: 'ask',
  tier: 2,
  description:
    'The command could not be safely classified and requires confirmation.',
};

const SAFE_BIN_RULE: PermissionRule = {
  id: 'safe-bin-profile',
  pattern: '*',
  decision: 'allow',
  tier: 0,
  description: 'This read-only diagnostic command matched a safe-bin profile.',
};

const GRANT_RULE: PermissionRule = {
  id: 'permission-grant',
  pattern: '*',
  decision: 'allow',
  tier: 0,
  description: 'This exact command was previously approved by the user.',
};

// Executables in this deliberately conservative list have no interpreter or
// dispatch wrapper semantics. Unknown executables fail closed instead.
/**
 * Commands that may run unattended.
 *
 * Membership means the command cannot modify data, change permissions, or
 * execute project code, for ANY argument it accepts. Anything that writes,
 * deletes, changes permissions, or runs another program's code is
 * deliberately absent and therefore always asks, because the Tier 0
 * fallback below approves anything in this set by default.
 *
 * Notably absent: chmod, chown, cp, make, mkdir, mv, npm, rm, sort (writes with
 * -o), systemctl, tee, touch, tsc, and vitest.
 */
const ROUTINE_EXECUTABLES = new Set([
  'basename',
  'cat',
  'cd',
  'date',
  'diff',
  'dirname',
  'echo',
  'false',
  'fd',
  'find',
  'grep',
  'id',
  'ls',
  'printf',
  'pwd',
  'readlink',
  'rg',
  'sleep',
  'stat',
  'test',
  'tree',
  'true',
  'uname',
  'which',
  'whoami',
]);

/**
 * Git subcommands that only read repository state.
 *
 * Everything else (push, commit with hooks, config with a pager, submodule
 * commands, aliases) can reach the network, run hooks, or execute code.
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'blame',
  'branch',
  'cat-file',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'whatchanged',
]);

/**
 * Runs `git <subcommand>` only when the subcommand cannot change anything.
 *
 * Global flags such as `-C path` or `--no-pager` are skipped so a harmless
 * invocation is not rejected for having a leading option.
 */
function isReadOnlyGitInvocation(argv: readonly string[]): boolean {
  let sawSubcommand = false;
  for (const token of argv.slice(1)) {
    if (token.startsWith('-')) {
      // Options that take a value would otherwise hide the subcommand.
      if (
        token === '-C' ||
        token === '-c' ||
        token === '--git-dir' ||
        token === '--work-tree' ||
        token === '--namespace'
      ) {
        return false;
      }
      continue;
    }
    if (!sawSubcommand) {
      if (!GIT_READ_ONLY_SUBCOMMANDS.has(token)) return false;
      sawSubcommand = true;
    }
  }
  return sawSubcommand;
}

/** `sort` only reads unless an output file is given. */
function isReadOnlySortInvocation(argv: readonly string[]): boolean {
  return !argv
    .slice(1)
    .some((token) => token === '-o' || token.startsWith('--output'));
}

const UNSAFE_DNF_RULE: PermissionRule = {
  id: 'unsafe-package-install',
  pattern: 'dnf install <unsafe-package-source-or-flag>',
  decision: 'ask',
  tier: 2,
  description:
    'Package installation uses a non-basic source, flag, or argument.',
};

function stripSudo(command: string): { command: string; sudo: boolean } {
  const normalized = command.trim();
  if (normalized === 'sudo') return { command: normalized, sudo: true };
  if (normalized === 'sudo -n') return { command: '', sudo: true };
  if (normalized.startsWith('sudo ')) {
    return { command: normalized.slice(5).trim(), sudo: true };
  }
  if (normalized.startsWith('sudo -n ')) {
    return { command: normalized.slice(7).trim(), sudo: true };
  }
  return { command: normalized, sudo: false };
}

function isDnfCommand(command: string): boolean {
  return command === 'dnf' || command.startsWith('dnf ');
}

const TRUSTED_EXECUTABLE_PREFIXES = [
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
];

function isAbsolutePermissionChange(command: string): boolean {
  return /^(?:sudo\s+)?(?:chmod|chown)\b[^;&|]*\s(?:\/|["']\/)/.test(command);
}

function isTrustedRoutineExecutable(segment: ShellCommandSegment): boolean {
  if (!segment.executableKnown) return false;
  // `PATH=/tmp/evil:$PATH ps` and `LD_PRELOAD=... ls` change which binary the
  // shell actually runs, so a prefixed command is never routine.
  if (segment.envPrefixes.length > 0) return false;
  if (segment.executable === null) return true;
  if (segment.executable === 'git') {
    if (!isTrustedExecutablePath(segment)) return false;
    return segment.argv !== null && isReadOnlyGitInvocation(segment.argv);
  }
  if (segment.executable === 'sort') {
    if (
      !ROUTINE_EXECUTABLES.has(segment.executable) &&
      !isTrustedExecutablePath(segment)
    ) {
      return false;
    }
    return segment.argv !== null && isReadOnlySortInvocation(segment.argv);
  }
  if (!ROUTINE_EXECUTABLES.has(segment.executable)) return false;
  return isTrustedExecutablePath(segment);
}

/** Returns whether the segment's executable lives in a trusted system path. */
function isTrustedExecutablePath(segment: ShellCommandSegment): boolean {
  const executablePath = segment.executablePath;
  if (!executablePath?.includes('/')) return true;
  if (
    !executablePath.startsWith('/') ||
    executablePath.split('/').includes('..')
  ) {
    return false;
  }
  return TRUSTED_EXECUTABLE_PREFIXES.some((prefix) =>
    executablePath.startsWith(prefix),
  );
}

/**
 * Produces a second, conservative spelling of a command for deny matching.
 *
 * Hard denies are matched against raw text, so `rm -rf "$HOME"`,
 * `rm -rf /home/`, `rm -rf //`, and `rm -rf $HOME` all slipped past
 * `rm -rf /`. A permanently blocked destruction must not be dodgeable by
 * spelling, so quotes, redundant slashes, trailing slashes, and the standard
 * home shorthands are normalized away before the deny rules are evaluated.
 */
export function normalizeForDenyMatching(command: string): string {
  const home = homedir();
  return command
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => {
      let value = token;
      // Drop one layer of matching surrounding quotes.
      const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
      if (quoted !== null) value = quoted[2] ?? '';
      // Expand only the home shorthands; other variables stay unresolved.
      value = value
        .replace(/^~(?=\/|$)/, home)
        .replace(/^\$\{HOME\}(?=\/|$)/, home)
        .replace(/^\$HOME(?=\/|$)/, home);
      // Collapse repeated slashes and drop a trailing one, keeping bare "/".
      value = value.replace(/\/{2,}/g, '/');
      if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
      // The hard-deny rules are written against "~", so map the expanded home
      // directory back to it. This is what makes `$HOME`, "$HOME", `~/`, and
      // `/home/titan` deny exactly like `~` already does.
      if (value === home) value = '~';
      else if (value.startsWith(`${home}/`))
        value = `~${value.slice(home.length)}`;
      return value === '' ? token : value;
    })
    .join(' ');
}

/**
 * Paths whose contents are secrets. Reading one sends it to the model
 * provider, so these ask even when the reader itself is read-only.
 */
// A path may be spelled absolutely or through the usual home shorthands, so
// the prefix class deliberately includes $, {, }, and ~ as well as word
// characters, dots and slashes.
const HOME_PREFIX = String.raw`[$\{\}\w./~-]*`;
const SENSITIVE_READ_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`[\s'"]${HOME_PREFIX}\.ssh\/(?:id_[a-z0-9]+|config)\b`,
    'i',
  ),
  new RegExp(String.raw`[\s'"]${HOME_PREFIX}\.aws\/credentials\b`, 'i'),
  new RegExp(String.raw`[\s'"]${HOME_PREFIX}\.config\/gcloud\b`, 'i'),
  new RegExp(String.raw`[\s'"]${HOME_PREFIX}\.netrc\b`, 'i'),
  new RegExp(String.raw`[\s'"]${HOME_PREFIX}\.npmrc\b`, 'i'),
  new RegExp(String.raw`[\s'"]\/?etc\/shadow\b`, 'i'),
  new RegExp(
    String.raw`[\s'"]${HOME_PREFIX}\.(?:pem|key|p12|pfx|keystore)\b`,
    'i',
  ),
  new RegExp(String.raw`[\s'"]${HOME_PREFIX}\.env(?:\.[\w-]+)?\b`, 'i'),
];

/** Returns whether the command appears to read a well-known secret path. */
export function readsSensitivePath(command: string): boolean {
  return SENSITIVE_READ_PATTERNS.some((pattern) => pattern.test(command));
}

const SENSITIVE_READ_RULE: PermissionRule = {
  id: 'ask-read-sensitive-path',
  pattern: '*',
  decision: 'ask',
  tier: 2,
  description:
    'Reading this file would send a credential or key to the model provider.',
};

/** Returns whether a dnf command is inside the narrow safe package policy. */
export function isSafePackageCommand(command: string): boolean {
  if (SHELL_META_CHARACTERS.test(command)) return false;
  const { command: withoutSudo } = stripSudo(command);
  if (!isDnfCommand(withoutSudo)) return false;
  if (withoutSudo.includes('http://') || withoutSudo.includes('https://')) {
    return false;
  }

  const tokens = withoutSudo.split(/\s+/).filter(Boolean);
  const subcommand = tokens[1];
  if (
    subcommand !== 'install' &&
    subcommand !== 'update' &&
    subcommand !== 'check-update'
  ) {
    return false;
  }
  if (
    DANGEROUS_INSTALL_MARKERS.some((marker) => withoutSudo.includes(marker))
  ) {
    return false;
  }

  let packageSeen = false;
  for (const token of tokens.slice(2)) {
    if (token.startsWith('-')) {
      if (!SAFE_INSTALL_FLAGS.has(token)) return false;
      continue;
    }
    if (!SAFE_PACKAGE_NAME.test(token)) return false;
    packageSeen = true;
  }

  if (subcommand === 'check-update') return !packageSeen;
  return packageSeen || subcommand === 'update';
}

/** Checks whether the explicit passwordless package setup file is installed. */
export async function isSudoWhitelistInstalled(): Promise<boolean> {
  return sudoersRuleExists();
}

/** Optional dependencies for risk classification. */
export interface RiskClassifierOptions {
  /** Additional user rules layered over the defaults. */
  userRules?: readonly PermissionRule[];
  /** Whether the explicit sudoers setup has been installed. */
  sudoWhitelistInstalled?: boolean;
  /** Session and durable exact-command grants. */
  grantMatcher?: GrantMatcher | undefined;
}

function assessmentFromEvaluation(
  evaluation: RuleEvaluation,
  sudoSetupRequired = false,
): RiskAssessment {
  const tier = evaluation.matchedRule.tier;
  return {
    tier,
    decision: evaluation.decision,
    matchedRule: evaluation.matchedRule,
    reason: evaluation.matchedRule.description,
    requiresConfirmation: evaluation.decision === 'ask' && tier === 2,
    sudoSetupRequired,
  };
}

/** Classifies shell commands without executing them. */
export class RiskClassifier {
  readonly #engine: RuleEngine;
  readonly #denyEngine: RuleEngine;
  readonly #userAskEngine: RuleEngine;
  readonly #sudoWhitelistInstalled: boolean;
  readonly #grantMatcher: GrantMatcher | undefined;

  public constructor(options: RiskClassifierOptions = {}) {
    const userRules = options.userRules ?? [];
    this.#engine = new RuleEngine(
      [...DEFAULT_PERMISSION_RULES, ...userRules],
      HARD_DENY_RULES,
    );
    this.#denyEngine = new RuleEngine(
      userRules.filter((rule) => rule.decision === 'deny'),
      HARD_DENY_RULES,
    );
    this.#userAskEngine = new RuleEngine(
      userRules.filter((rule) => rule.decision === 'ask'),
    );
    this.#sudoWhitelistInstalled = options.sudoWhitelistInstalled ?? false;
    this.#grantMatcher = options.grantMatcher;
  }

  /** Evaluates one command and returns the effective permission action. */
  public assess(command: string, cwd: string = process.cwd()): RiskAssessment {
    const normalized = command.trim();
    const wholeGate = this.#wholeCommandGate(normalized);
    if (wholeGate !== undefined) return wholeGate;
    let structure;
    try {
      structure = extractShellStructure(normalized);
    } catch {
      return this.#unknownAssessment();
    }
    const assessments: RiskAssessment[] = structure.commands.map((segment) =>
      this.#assessSimple(segment, cwd),
    );
    for (const nested of structure.nestedScripts) {
      assessments.push(this.#assessScript(nested, normalized, cwd));
    }
    if (structure.unknown) assessments.push(this.#unknownAssessment());
    return this.#aggregate(assessments);
  }

  #assessScript(
    script: ParsedScript,
    parentSource: string,
    cwd: string,
  ): RiskAssessment {
    const source = script.source ?? parentSource;
    const wholeGate = this.#wholeCommandGate(source);
    if (wholeGate !== undefined) return wholeGate;
    let structure;
    try {
      structure = extractParsedShellStructure(script, source);
    } catch {
      return this.#unknownAssessment();
    }
    const assessments = structure.commands.map((segment) =>
      this.#assessSimple(segment, cwd),
    );
    for (const nested of structure.nestedScripts) {
      assessments.push(this.#assessScript(nested, source, cwd));
    }
    if (structure.unknown) assessments.push(this.#unknownAssessment());
    return this.#aggregate(assessments);
  }

  #assessSimple(segment: ShellCommandSegment, cwd: string): RiskAssessment {
    const normalized = segment.source.trim();
    const evaluation = this.#engine.evaluate(normalized);

    if (evaluation?.decision === 'deny') {
      return this.#denyAssessment(evaluation);
    }

    if (isSafePackageCommand(normalized)) {
      const { sudo } = stripSudo(normalized);
      if (sudo && !this.#sudoWhitelistInstalled) {
        return {
          tier: 2,
          decision: 'ask',
          matchedRule: SUDO_SETUP_RULE,
          reason:
            'Passwordless package management is not configured. Run "atlas permissions setup" first.',
          requiresConfirmation: true,
          sudoSetupRequired: true,
        };
      }
      if (evaluation?.decision === 'ask') {
        return assessmentFromEvaluation(evaluation);
      }
      return {
        tier: 0,
        decision: 'allow',
        matchedRule: SAFE_DNF_RULE,
        reason: 'Package command matches the narrow pre-approved policy.',
        requiresConfirmation: false,
        sudoSetupRequired: false,
      };
    }

    const { command: withoutSudo, sudo } = stripSudo(normalized);
    if (sudo) {
      if (evaluation?.decision === 'ask') {
        return assessmentFromEvaluation(evaluation);
      }
      return {
        tier: 2,
        decision: 'ask',
        matchedRule: SUDO_RULE,
        reason: SUDO_RULE.description,
        requiresConfirmation: true,
        sudoSetupRequired: false,
      };
    }
    if (withoutSudo.startsWith('dnf install ')) {
      return {
        tier: 2,
        decision: 'ask',
        matchedRule: UNSAFE_DNF_RULE,
        reason:
          'Package installation uses a non-basic source, flag, path, or shell syntax.',
        requiresConfirmation: true,
        sudoSetupRequired: false,
      };
    }

    const grant = this.#grantMatcher?.match(segment, cwd);
    if (grant !== undefined) {
      return {
        tier: 0,
        decision: 'allow',
        matchedRule: GRANT_RULE,
        reason: GRANT_RULE.description,
        requiresConfirmation: false,
        sudoSetupRequired: false,
      };
    }

    if (isAbsolutePermissionChange(normalized)) {
      if (evaluation?.decision === 'ask') {
        return assessmentFromEvaluation(evaluation);
      }
      return {
        tier: 2,
        decision: 'ask',
        matchedRule: SYSTEM_PERMISSION_RULE,
        reason: SYSTEM_PERMISSION_RULE.description,
        requiresConfirmation: true,
        sudoSetupRequired: false,
      };
    }

    if (isSafeBinSegment(segment) && !segment.hasFileWriteRedirect) {
      return {
        tier: 0,
        decision: 'allow',
        matchedRule: SAFE_BIN_RULE,
        reason: SAFE_BIN_RULE.description,
        requiresConfirmation: false,
        sudoSetupRequired: false,
      };
    }
    if (evaluation?.decision === 'ask') {
      return assessmentFromEvaluation(evaluation);
    }
    if (segment.hasFileWriteRedirect) {
      return {
        tier: 3,
        decision: 'allow',
        matchedRule: FILE_WRITE_RULE,
        reason: FILE_WRITE_RULE.description,
        requiresConfirmation: false,
        sudoSetupRequired: false,
      };
    }
    if (!isTrustedRoutineExecutable(segment)) {
      return this.#unknownAssessment();
    }
    if (
      segment.executable === 'find' &&
      /(^|\s)-(?:exec|execdir|ok|okdir)(?:\s|$)/.test(normalized)
    ) {
      return this.#unknownAssessment();
    }
    if (evaluation === undefined) {
      return {
        tier: 0,
        decision: 'allow',
        matchedRule: DEFAULT_ALLOW_RULE,
        reason: DEFAULT_ALLOW_RULE.description,
        requiresConfirmation: false,
        sudoSetupRequired: false,
      };
    }
    return assessmentFromEvaluation(evaluation);
  }

  #wholeCommandGate(command: string): RiskAssessment | undefined {
    const deny =
      this.#denyEngine.evaluate(command) ??
      this.#denyEngine.evaluate(normalizeForDenyMatching(command));
    if (deny?.decision === 'deny') return this.#denyAssessment(deny);
    const ask = this.#userAskEngine.evaluate(command);
    if (ask?.decision === 'ask') return assessmentFromEvaluation(ask);
    // Checked here, ahead of the structural, safe-bin, and grant layers, so
    // that a read-only profile or a durable grant can never auto-approve a
    // secret read.
    if (readsSensitivePath(command)) {
      return assessmentFromEvaluation({
        matchedRule: SENSITIVE_READ_RULE,
        decision: SENSITIVE_READ_RULE.decision,
      });
    }
    return undefined;
  }

  #denyAssessment(evaluation: RuleEvaluation): RiskAssessment {
    return {
      ...assessmentFromEvaluation(evaluation),
      tier: evaluation.matchedRule.tier === 0 ? 2 : evaluation.matchedRule.tier,
      decision: 'deny',
      requiresConfirmation: false,
    };
  }

  #unknownAssessment(): RiskAssessment {
    return {
      tier: 2,
      decision: 'ask',
      matchedRule: UNKNOWN_COMMAND_RULE,
      reason: UNKNOWN_COMMAND_RULE.description,
      requiresConfirmation: true,
      sudoSetupRequired: false,
    };
  }

  #aggregate(assessments: readonly RiskAssessment[]): RiskAssessment {
    if (assessments.length === 0) return this.#unknownAssessment();
    const deny = assessments.find(
      (assessment) => assessment.decision === 'deny',
    );
    if (deny !== undefined) return deny;
    const ask = assessments.find((assessment) => assessment.decision === 'ask');
    if (ask !== undefined) return ask;
    return assessments.reduce((highest, assessment) =>
      assessment.tier > highest.tier ? assessment : highest,
    );
  }
}
