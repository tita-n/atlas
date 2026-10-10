/**
 * Previewing what a command would do, without doing it.
 *
 * There is no universal dry-run flag, and the closest-looking thing is a trap:
 * `cp -n` and `mv -n` mean "do not overwrite an existing destination", NOT "do
 * nothing". They still copy and move every file that does not collide. Treating
 * `-n` as a preview would run a destructive command in the name of showing the
 * user what it would do, so those are explicitly excluded rather than inferred.
 *
 * Commands with a genuine native preview are preferred, because they describe
 * their own effect accurately and Atlas cannot simulate an effect it does not
 * understand. Everything else gets a static preview only: Atlas says what the
 * command appears to do and runs nothing at all.
 */

export type PreviewMethod =
  /** The tool can describe its own effect; run it with a native preview flag. */
  | 'native'
  /** No native preview exists; describe it statically and execute nothing. */
  | 'static';

export interface DryRunPlan {
  readonly method: PreviewMethod;
  /** The command as it would be run, including any added preview flag. */
  readonly command: string;
  /**
   * Why the native preview may be incomplete, when it is.
   *
   * `make -n` prints recipes but some recursive recipes still execute, so the
   * caller is told rather than left to assume otherwise.
   */
  readonly caveat?: string;
}

/** Commands whose `-n` flag is a no-clobber flag, not a preview. */
const NOT_A_PREVIEW = new Set(['cp', 'mv', 'ln']);

/**
 * Characters that make the command a shell script rather than one argv.
 *
 * A preview flag appended to such a string lands somewhere the tool cannot
 * control: `rsync -av src/ dst/ | cat` becomes `... | cat --dry-run`, which
 * runs rsync for real and previews `cat`. Globs are deliberately NOT here: an
 * unexpanded glob is part of a single argv and the shell expands it identically
 * either way, so blocking them would refuse to preview ordinary commands.
 */
const SHELL_OPERATOR_CHARACTERS = '|;&<>`()[]{}';

/** Whether a command is a shell script rather than a single argv. */
function hasShellOperator(command: string): boolean {
  return SHELL_OPERATOR_CHARACTERS.split('').some((char) =>
    command.includes(char),
  );
}

/**
 * Native previews, keyed by the command and, where needed, the subcommand.
 *
 * Kept deliberately small: only entries that were verified to be genuine
 * previews. A missing entry means "no native preview", which is safe, whereas
 * a wrong entry means Atlas runs something it should not.
 */
const NATIVE_PREVIEWS: Readonly<Record<string, readonly string[]>> = {
  rsync: ['--dry-run', '-n'],
  'apt-get': ['--simulate', '-s'],
  apt: ['--simulate', '-s'],
  patch: ['--dry-run'],
  make: ['--dry-run', '-n'],
  git: ['--dry-run'],
  npm: ['--dry-run'],
  pnpm: ['--dry-run'],
  yarn: ['--dry-run'],
};

/** Git subcommands verified to accept a dry-run flag. */
const GIT_PREVIEW_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  clean: ['--dry-run', '-n'],
  add: ['--dry-run', '-n'],
  push: ['--dry-run'],
  rm: ['--dry-run'],
  mv: ['--dry-run'],
};

/** Subcommands whose native preview is known to be incomplete. */
const PREVIEW_CAVEATS: Readonly<Record<string, string>> = {
  make:
    'make prints the recipes it would run, but recursive recipes and ' +
    'makefile-update targets can still execute.',
};

/** Splits a command into its executable and arguments. */
export function parseCommandLine(command: string): {
  executable: string;
  args: readonly string[];
} {
  const trimmed = command.trim();
  if (trimmed === '') return { executable: '', args: [] };
  const parts = trimmed.split(/\s+/);
  return { executable: parts[0] ?? '', args: parts.slice(1) };
}

/** The bare command name, with any leading path removed. */
function baseName(executable: string): string {
  const slash = executable.lastIndexOf('/');
  return slash === -1 ? executable : executable.slice(slash + 1);
}

/**
 * Whether the command already carries a preview flag.
 *
 * Only flags Atlas would itself have added count, and only for the command
 * that owns them. `-s` is a preview flag for apt but a send-signal flag for
 * kill, and `-n` is a preview flag for make but no-clobber for cp; treating
 * any of them as "already previewing" runs the real command unchanged.
 */
function alreadyPreviewing(
  args: readonly string[],
  ownedFlags: readonly string[],
): boolean {
  return args.some((arg) => ownedFlags.includes(arg));
}

/**
 * Builds a preview plan for a command.
 *
 * Always succeeds: an unknown command gets a static plan that runs nothing,
 * rather than an error that would leave the user unable to preview anything.
 */
export function planDryRun(command: string): DryRunPlan {
  // A shell script cannot be previewed by appending a flag: the flag would
  // apply to whichever command happens to come last, leaving the earlier ones
  // running for real. Describe it instead of guessing.
  if (hasShellOperator(command)) {
    return {
      method: 'static',
      command,
      caveat:
        'This command chains several commands with a shell operator, so a ' +
        'preview flag could not cover all of them. Atlas is describing it ' +
        'statically and running nothing.',
    };
  }

  const { executable, args } = parseCommandLine(command);
  const name = baseName(executable);

  // Never touch these. `-n` here is a no-clobber flag and the command still
  // performs its work.
  if (NOT_A_PREVIEW.has(name)) {
    return { method: 'static', command, ...staticCaveat(name) };
  }

  const flags = NATIVE_PREVIEWS[name];

  if (name === 'git') {
    const subcommand = args.find((arg) => !arg.startsWith('-'));
    const subcommandFlags =
      subcommand === undefined
        ? []
        : (GIT_PREVIEW_SUBCOMMANDS[subcommand] ?? []);
    if (subcommandFlags.length > 0) {
      if (alreadyPreviewing(args, subcommandFlags)) {
        // The user already asked for a preview; running it as given is correct.
        return { method: 'native', command };
      }
      return {
        method: 'native',
        command: `${command} ${subcommandFlags[0] ?? '--dry-run'}`,
      };
    }
    return {
      method: 'static',
      command,
      caveat:
        'git has no global dry-run; only some subcommands accept one, so ' +
        'Atlas will describe this instead of running it.',
    };
  }

  if (flags !== undefined && flags.length > 0) {
    if (alreadyPreviewing(args, flags)) {
      return { method: 'native', command };
    }
    const caveat = PREVIEW_CAVEATS[name];
    return {
      method: 'native',
      command: command + ' ' + (flags[0] ?? '--dry-run'),
      ...(caveat === undefined ? {} : { caveat }),
    };
  }

  return { method: 'static', command, ...staticCaveat(name) };
}

function staticCaveat(name: string): { caveat: string } {
  if (NOT_A_PREVIEW.has(name)) {
    return {
      caveat:
        `${name} -n means "do not overwrite", not "do nothing" — it would ` +
        'still perform the copy or move. Atlas is describing this instead of ' +
        'running it.',
    };
  }
  return {
    caveat:
      `No verified preview exists for ${name}, so Atlas is describing the ` +
      'command statically and running nothing.',
  };
}

/** Commands with no true preview, listed so the UI can say so plainly. */
export function hasNativePreview(command: string): boolean {
  return planDryRun(command).method === 'native';
}

/**
 * A short, honest description of what a command appears to do.
 *
 * Deliberately structural rather than clever: it reports the command and the
 * argument shape, not a prediction about an effect Atlas cannot verify.
 */
export function describeCommand(command: string): string {
  const { executable, args } = parseCommandLine(command);
  if (executable === '') return 'an empty command';
  const name = baseName(executable);
  const verb = VERBS[name];
  if (verb === undefined) {
    return args.length === 0
      ? name
      : name +
          ' with ' +
          String(args.length) +
          ' argument' +
          (args.length === 1 ? '' : 's');
  }
  const targets = args.filter((arg) => !arg.startsWith('-'));
  if (targets.length === 0) return `${verb} (no target given)`;
  return `${verb} ${targets.slice(0, 2).join(', ')}${
    targets.length > 2 ? `, and ${targets.length - 2} more` : ''
  }`;
}

/** Plain-language verbs for the commands Atlas can describe confidently. */
const VERBS: Readonly<Record<string, string>> = {
  rm: 'permanently delete',
  rmdir: 'remove empty directories',
  mv: 'move',
  cp: 'copy',
  chmod: 'change permissions on',
  chown: 'change ownership of',
  kill: 'terminate',
  pkill: 'terminate processes matching',
  dd: 'overwrite raw bytes in',
  truncate: 'truncate',
  shutdown: 'shut down the system',
  reboot: 'reboot the system',
  git: 'run git',
  npm: 'run npm',
  rsync: 'synchronise with',
  make: 'build with make',
  apt: 'manage packages with apt',
  // Quoted: an unquoted hyphenated key like apt-get: is a syntax error.
  'apt-get': 'manage packages with apt-get',
};
