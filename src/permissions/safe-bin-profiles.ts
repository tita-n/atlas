import { basename } from 'node:path';
import type { ShellCommandSegment } from './shell-structure.js';
import { resolveTrustedExecutablePath } from './executable-path.js';

export {
  TRUSTED_PREFIXES,
  resolveExecutablePath,
  resolveTrustedExecutablePath,
} from './executable-path.js';

const COMMON_LONG_FLAGS = new Set([
  '--help',
  '--version',
  '--no-pager',
  '--color',
  '--no-color',
]);

const COMMON_SHORT_FLAGS = new Set(['h', 'V', 'p', 'a', 'A']);

interface FlagProfile {
  readonly long: ReadonlySet<string>;
  readonly valueLong: ReadonlySet<string>;
  readonly short: ReadonlySet<string>;
  readonly valueShort: ReadonlySet<string>;
  /**
   * Whether a bare `-<digits>` token is the default value option's argument.
   *
   * `head -40 file` is old-style POSIX for `head -n 40 file`, so the digits
   * are a value rather than a cluster of single-letter flags.
   */
  readonly digitValue?: boolean;
  readonly positional?: (token: string) => boolean;
}

function profileFromFlags(
  long: readonly string[],
  valueLong: readonly string[] = [],
  short: readonly string[] = [],
  valueShort: readonly string[] = [],
  positional: (token: string) => boolean = () => true,
  digitValue = false,
): FlagProfile {
  return {
    long: new Set(long),
    valueLong: new Set(valueLong),
    short: new Set(short),
    valueShort: new Set(valueShort),
    positional,
    digitValue,
  };
}

function flagsAreSafe(argv: readonly string[], profile: FlagProfile): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      if (profile.valueLong.has(name)) {
        if (equals === -1) index += 1;
        continue;
      }
      if (!profile.long.has(name)) return false;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const characters = token.slice(1).split('');
      if (
        profile.digitValue === true &&
        characters.every((character) => character >= '0' && character <= '9')
      ) {
        continue;
      }
      for (let position = 0; position < characters.length; position += 1) {
        const character = characters[position] ?? '';
        if (profile.valueShort.has(character)) {
          if (position === characters.length - 1) index += 1;
          break;
        }
        if (!profile.short.has(character)) return false;
      }
      continue;
    }
    if (profile.positional !== undefined && !profile.positional(token))
      return false;
  }
  return true;
}

function profile(
  name: string,
  description: string,
  validator: (argv: readonly string[]) => boolean,
): SafeBinProfile {
  return { name, description, validate: validator };
}

/** A curated, read-only executable profile. */
export interface SafeBinProfile {
  /** Executable basename. */
  readonly name: string;
  /** Human-readable reason shown when the profile is used. */
  readonly description: string;
  /** Validates argv tokens after the executable name. */
  readonly validate: (argv: readonly string[]) => boolean;
}

const PS_FLAGS = profileFromFlags(
  [
    ...COMMON_LONG_FLAGS,
    '--forest',
    '--forest-roots',
    '--all',
    '--deselect',
    '--sort',
    '--pid',
    '--ppid',
    '--uid',
    '--real-uid',
    '--user',
    '--group',
    '--euid',
    '--egid',
    '--tty',
    '--pid',
    '--no-headers',
    '--width',
    '--quick-pid',
    '--cumulative',
    '--sid',
    '--ppid',
  ],
  [
    '--sort',
    '--pid',
    '--ppid',
    '--user',
    '--uid',
    '--group',
    '--tty',
    '--sid',
    '--width',
  ],
  [
    ...COMMON_SHORT_FLAGS,
    'f',
    'F',
    'j',
    'l',
    'y',
    'o',
    'O',
    'u',
    'U',
    'g',
    'G',
    't',
    'e',
    'r',
    'R',
    'C',
    'c',
    's',
    'S',
    'm',
    'M',
    'x',
    'X',
    'Z',
  ],
  ['o', 'p', 'u', 'U', 'g', 'G', 't', 's', 'S', 'm', 'M', 'c'],
);

const TOP_FLAGS = profileFromFlags(
  [
    ...COMMON_LONG_FLAGS,
    '--batch',
    '--iterations',
    '--delay',
    '--pid',
    '--user',
    '--sort',
    '--forest',
    '--start-time',
  ],
  ['--pid', '--user', '--sort', '--delay', '--iterations', '--start-time'],
  [...COMMON_SHORT_FLAGS, 'b', 'c', 'd', 'H', 'o', 's', 'w', 'n', 'u', 'q'],
  ['n', 'd', 'p', 'u', 'o', 's', 'w'],
  () => false,
);

const SYSTEMD_CGTOP_FLAGS = profileFromFlags(
  [
    '--order',
    '--depth',
    '--cpu',
    '--io',
    '--task',
    '--unit',
    '--batch',
    '--iterations',
    '--help',
    '--version',
  ],
  ['--order', '--depth', '--cpu', '--io', '--task', '--unit', '--iterations'],
  ['b', 'h'],
  ['n'],
  () => false,
  true,
);

const FREE_FLAGS = profileFromFlags(
  [
    ...COMMON_LONG_FLAGS,
    '--bytes',
    '--mega',
    '--giga',
    '--tera',
    '--petabyte',
    '--exabyte',
    '--si',
    '--human-readable',
    '--wide',
    '--seconds',
    '--total',
    '--count',
    '--repeat',
  ],
  ['--repeat'],
  [
    ...COMMON_SHORT_FLAGS,
    'b',
    'm',
    'g',
    't',
    'p',
    'w',
    's',
    'c',
    'N',
    'l',
    'v',
    'o',
  ],
  ['s'],
);

const DF_FLAGS = profileFromFlags(
  [
    ...COMMON_LONG_FLAGS,
    '--all',
    '--human-readable',
    '--inode',
    '--local',
    '--portability',
    '--types',
    '--block-size',
    '--output',
    '--total',
    '--apparent-size',
    '--nodiratime',
    '--time-style',
  ],
  ['--block-size', '--output', '--time-style', '--exclude-type'],
  [...COMMON_SHORT_FLAGS, 'a', 'B', 'h', 'H', 'i', 'l', 'P', 'T', 'x', 'C'],
  ['B'],
);

const DU_FLAGS = profileFromFlags(
  [
    ...COMMON_LONG_FLAGS,
    '--summarize',
    '--all',
    '--count',
    '--dereference',
    '--max-depth',
    '--apparent-size',
    '--bytes',
    '--total',
    '--null',
    '--files0-from',
    '--exclude',
    '--time',
    '--threshold',
  ],
  [
    '--max-depth',
    '--block-size',
    '--exclude',
    '--time',
    '--threshold',
    '--files0-from',
  ],
  [
    ...COMMON_SHORT_FLAGS,
    'a',
    'c',
    'd',
    'l',
    'L',
    'H',
    'k',
    'm',
    'g',
    'B',
    's',
    'x',
    '0',
    '1',
    'P',
    'T',
    'C',
    'E',
  ],
  ['-'],
  (token) => !token.startsWith('-'),
);

const LSBLK_FLAGS = profileFromFlags(
  [
    ...COMMON_LONG_FLAGS,
    '--bytes',
    '--pairs',
    '--inverse',
    '--nodeps',
    '--noheadings',
    '--output',
    '--tree',
    '--width',
    '--paths',
    '--json',
    '--fs',
    '--mountpoint',
  ],
  ['--output', '--width', '--paths', '--sort', '--filter', '--mtab'],
  [
    ...COMMON_SHORT_FLAGS,
    'b',
    'd',
    'D',
    'f',
    'I',
    'J',
    'l',
    'm',
    'n',
    'o',
    'p',
    'P',
    'r',
    's',
    't',
    'u',
    'U',
    'V',
    'z',
  ],
  ['o', 'I', 'm', 's', 'n'],
);

const SENSORS_FLAGS = profileFromFlags(
  [
    '--json',
    '--celsius',
    '--fahrenheit',
    '--color',
    '--no-color',
    '--verbose',
    '--help',
    '--version',
    '--chip',
    '--all',
    '--bus',
    '--bus-info',
    '--list-chips',
    '--quiet',
    '--debug',
  ],
  ['--chip', '--bus'],
  ['j', 'c', 'f', 'v', 'u', 's', 'A', 'F', 'p', 'q', 'd'],
  ['u', 's'],
  () => false,
);

const TLP_STAT_FLAGS = profileFromFlags(
  [
    '--acpi',
    '--bat',
    '--chargers',
    '--json',
    '--verbose',
    '--debug',
    '--help',
    '--version',
    '--celsius',
    '--fahrenheit',
    '--nomahw',
    '--nomodes',
  ],
  [],
  ['b', 'c', 'p', 't', 'a', 'j', 'v', 'd'],
  [],
  () => false,
);

const JOURNALCTL_FLAGS = new Set([
  '--no-pager',
  '--all',
  '-a',
  '--boot',
  '-b',
  '--unit',
  '-u',
  '--user',
  '-u',
  '--system',
  '--kernel',
  '-k',
  '--since',
  '--until',
  '--since',
  '--after-cursor',
  '--before-cursor',
  '--grep',
  '--case-sensitive',
  '--no-case-sensitive',
  '--reverse',
  '--output',
  '-o',
  '--priority',
  '-p',
  '--lines',
  '-n',
  '--header',
  '-N',
  '--identifier',
  '-t',
  '--directory',
  '--file',
  '--root',
  '--image',
  '--namespace',
  '--machine',
  '--list-boots',
  '--verify',
  '--quiet',
  '-q',
  '--follow',
  '-f',
  '--interval',
  '--timeout',
  '--activate-unit',
  '--deactivate',
  '--is-running',
]);

function isJournalctlSafe(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (
      token.startsWith('--vacuum-') ||
      token === '--rotate' ||
      token === '--flush' ||
      token === '--sync' ||
      token === '--reload' ||
      token === '--smart-relock' ||
      token === '--setup-keys'
    ) {
      return false;
    }
    if (token.startsWith('-') && !JOURNALCTL_FLAGS.has(token)) return false;
    if (
      [
        '--since',
        '--until',
        '-u',
        '--unit',
        '-n',
        '--lines',
        '-o',
        '--output',
        '-p',
        '--priority',
        '--grep',
        '--boot',
        '-b',
        '--directory',
        '--file',
        '--root',
        '--image',
        '--namespace',
        '--interval',
      ].includes(token)
    ) {
      index += 1;
    }
  }
  return true;
}

const TEXT_FLAG_PROFILES = new Map<string, FlagProfile>([
  [
    'cut',
    profileFromFlags(
      [
        '--bytes',
        '--characters',
        '--fields',
        '--delimiter',
        '--output-delimiter',
        '--complement',
        '--only-delimited',
        '--zero-terminated',
      ],
      [
        '--bytes',
        '--characters',
        '--fields',
        '--delimiter',
        '--output-delimiter',
      ],
      ['b', 'c', 'f', 'd', 's', 'z'],
      ['b', 'c', 'f', 'd', 's'],
    ),
  ],
  [
    'uniq',
    profileFromFlags(
      [
        '--skip-fields',
        '--skip-chars',
        '--check-chars',
        '--all-repeated',
        '--count',
        '--repeated',
        '--unique',
        '--ignore-case',
        '--zero-terminated',
      ],
      ['--skip-fields', '--skip-chars', '--check-chars'],
      ['f', 's', 'w', 'c', 'd', 'u', 'i', 'z'],
      ['f', 's'],
    ),
  ],
  [
    'head',
    profileFromFlags(
      [
        '--lines',
        '--bytes',
        '--quiet',
        '--silent',
        '--verbose',
        '--zero-terminated',
      ],
      ['--lines', '--bytes'],
      ['n', 'c', 'q', 's', 'v', 'z'],
      ['n', 'c'],
      () => true,
      true,
    ),
  ],
  [
    'tail',
    profileFromFlags(
      [
        '--lines',
        '--bytes',
        '--sleep-interval',
        '--quiet',
        '--silent',
        '--verbose',
        '--zero-terminated',
        '--follow',
        '--retry',
      ],
      ['--lines', '--bytes', '--sleep-interval', '--retry'],
      ['n', 'c', 'q', 's', 'v', 'z', 'f', 'F'],
      ['n', 'c'],
      () => true,
      true,
    ),
  ],
  [
    'tr',
    profileFromFlags(
      ['--complement', '--delete', '--squeeze-repeats', '--truncate-set1'],
      [],
      ['c', 'd', 's', 't'],
      ['d', 's', 't'],
    ),
  ],
  [
    'wc',
    profileFromFlags(
      ['--bytes', '--chars', '--lines', '--max-line-length', '--words'],
      [],
      ['c', 'm', 'L', 'l', 'w'],
      [],
    ),
  ],
]);

function isTextUtilitySafe(name: string, argv: readonly string[]): boolean {
  const flagProfile = TEXT_FLAG_PROFILES.get(name);
  return flagProfile !== undefined && flagsAreSafe(argv, flagProfile);
}

export const SAFE_BIN_PROFILES: Readonly<Record<string, SafeBinProfile>> = {
  ps: profile('ps', 'Process inspection only.', (argv) =>
    flagsAreSafe(argv, PS_FLAGS),
  ),
  top: profile('top', 'Process viewer only.', (argv) =>
    flagsAreSafe(argv, TOP_FLAGS),
  ),
  systemd: profile('systemd', 'Not a safe-bin profile.', () => false),
  'systemd-cgtop': profile(
    'systemd-cgtop',
    'Systemd resource viewer only.',
    (argv) => flagsAreSafe(argv, SYSTEMD_CGTOP_FLAGS),
  ),
  htop: profile('htop', 'Interactive process viewer only.', (argv) =>
    flagsAreSafe(argv, TOP_FLAGS),
  ),
  free: profile('free', 'Memory usage report only.', (argv) =>
    flagsAreSafe(argv, FREE_FLAGS),
  ),
  df: profile('df', 'Filesystem usage report only.', (argv) =>
    flagsAreSafe(argv, DF_FLAGS),
  ),
  du: profile('du', 'Directory usage report only.', (argv) =>
    flagsAreSafe(argv, DU_FLAGS),
  ),
  lsblk: profile('lsblk', 'Block-device information only.', (argv) =>
    flagsAreSafe(argv, LSBLK_FLAGS),
  ),
  ip: profile('ip', 'Network information query only.', (argv) =>
    isIpQuerySafe(argv),
  ),
  ss: profile('ss', 'Socket information query only.', (argv) =>
    flagsAreSafe(argv, SS_FLAGS),
  ),
  sensors: profile('sensors', 'Hardware sensor report only.', (argv) =>
    flagsAreSafe(argv, SENSORS_FLAGS),
  ),
  upower: profile('upower', 'Power-device query only.', (argv) =>
    isUpowerQuerySafe(argv),
  ),
  'tlp-stat': profile('tlp-stat', 'Power-policy status report only.', (argv) =>
    flagsAreSafe(argv, TLP_STAT_FLAGS),
  ),
  journalctl: profile(
    'journalctl',
    'Journal read-only query only.',
    isJournalctlSafe,
  ),
  cut: profile('cut', 'Text field projection only.', (argv) =>
    isTextUtilitySafe('cut', argv),
  ),
  uniq: profile('uniq', 'Duplicate-line report only.', (argv) =>
    isTextUtilitySafe('uniq', argv),
  ),
  head: profile('head', 'Text prefix reader only.', (argv) =>
    isTextUtilitySafe('head', argv),
  ),
  tail: profile('tail', 'Text suffix reader only.', (argv) =>
    isTextUtilitySafe('tail', argv),
  ),
  tr: profile('tr', 'Text transformation reader only.', (argv) =>
    isTextUtilitySafe('tr', argv),
  ),
  wc: profile('wc', 'Text counting reader only.', (argv) =>
    isTextUtilitySafe('wc', argv),
  ),
};

function isIpQuerySafe(argv: readonly string[]): boolean {
  const args = argv.slice(1);
  const objectNames = new Set([
    'addr',
    'address',
    'route',
    'link',
    'neigh',
    'rule',
    'netns',
  ]);
  let index = 0;
  while (index < args.length) {
    const token = args[index] ?? '';
    if (
      [
        '-4',
        '-6',
        '-br',
        '-brief',
        '-o',
        '-oneline',
        '-c',
        '-color',
        '-f',
        '-force',
        '-s',
        '-silent',
      ].includes(token)
    ) {
      index += 1;
      continue;
    }
    if (objectNames.has(token)) {
      const subcommand = args[index + 1];
      return (
        subcommand === 'show' || subcommand === 'list' || subcommand === 'get'
      );
    }
    return false;
  }
  return false;
}

const SS_FLAGS = profileFromFlags(
  [
    '--all',
    '--tcp',
    '--udp',
    '--unix',
    '--raw',
    '--listening',
    '--numeric',
    '--resolve',
    '--verbose',
    '--help',
    '--version',
    '--no-header',
    '--options',
    '--match',
    '--exclude',
    '--info',
    '--summary',
  ],
  ['--match', '--exclude', '--options'],
  ['a', 't', 'u', 'x', 'n', 'l', 'r', 'p', 'e', 'o', 'm', 'c', 'i', 's'],
  [],
  () => false,
);

function isUpowerQuerySafe(argv: readonly string[]): boolean {
  const args = argv.slice(1);
  const queries = new Set([
    'show',
    'dump',
    'devices',
    'enumerate',
    'monitor',
    '-d',
    '--dump',
    '--show',
    '--devices',
    '--enumerate',
    '--monitor',
  ]);
  return (
    args.some((token) => queries.has(token)) &&
    args.every((token) => token.startsWith('-') || queries.has(token))
  );
}

/** Resolves a binary and accepts only canonical system paths. */
/** Validates argv against a named curated profile without resolving a path. */
export function matchesSafeBinProfile(
  executableName: string,
  argv: readonly string[],
): boolean {
  return SAFE_BIN_PROFILES[executableName]?.validate(argv) ?? false;
}

/** Returns whether a segment satisfies a curated read-only profile. */
export function isSafeBinSegment(segment: ShellCommandSegment): boolean {
  // An env-assignment prefix can redirect the very binary being profiled, so
  // the profile no longer describes what will run.
  if (segment.envPrefixes.length > 0) return false;
  if (segment.executable === null || segment.argv === null) return false;
  const resolved = resolveTrustedExecutablePath(
    segment.executablePath ?? segment.executable,
  );
  if (resolved === undefined) return false;
  const executableName = basename(resolved);
  return SAFE_BIN_PROFILES[executableName]?.validate(segment.argv) ?? false;
}
