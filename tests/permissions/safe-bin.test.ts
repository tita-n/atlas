import { describe, expect, it } from 'vitest';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';
import {
  isSafeBinSegment,
  matchesSafeBinProfile,
} from '../../src/permissions/safe-bin-profiles.js';
import type { ShellCommandSegment } from '../../src/permissions/shell-structure.js';

function segment(
  executable: string,
  executablePath: string,
  argv: string[],
): ShellCommandSegment {
  return {
    source: [executable, ...argv].join(' '),
    executable,
    executablePath,
    executableKnown: true,
    argv,
    hasFileWriteRedirect: false,
    envPrefixes: [],
  };
}

describe('safe-bin profiles', () => {
  it.each([
    ['ps', ['aux', '--sort=-%cpu']],
    ['top', ['-b', '-n', '1']],
    ['systemd-cgtop', ['--depth', '2']],
    ['free', ['-h']],
    ['df', ['-h']],
    ['du', ['-sh', '/tmp']],
    ['lsblk', ['-f']],
    ['ip', ['addr', 'show']],
    ['ss', ['-tulpn']],
    ['sensors', ['-j']],
    ['upower', ['--dump']],
    ['tlp-stat', ['-b']],
    ['journalctl', ['-n', '20']],
    ['head', ['-n', '5']],
    ['tail', ['-f', 'file.log']],
    ['cut', ['-d:', '-f1', 'file.txt']],
    ['uniq', ['file.txt']],
    ['tr', ['a-z', 'A-Z']],
    ['wc', ['-l', 'file.txt']],
  ])('accepts a read-only %s invocation', (executable, argv) => {
    expect(matchesSafeBinProfile(executable, [executable, ...argv])).toBe(true);
  });

  it('rejects mutating or unsafe modes of safe-bin tools', () => {
    expect(matchesSafeBinProfile('ip', ['ip', 'addr', 'add', '10.0.0.1'])).toBe(
      false,
    );
    expect(
      matchesSafeBinProfile('journalctl', ['journalctl', '--vacuum-time=1s']),
    ).toBe(false);
    expect(
      matchesSafeBinProfile('upower', ['upower', 'set', 'charge_threshold']),
    ).toBe(false);
  });

  it('does not trust a same-named binary outside a canonical system path', () => {
    const untrusted = segment('ps', '/tmp/ps', ['ps', 'aux']);
    expect(isSafeBinSegment(untrusted)).toBe(false);
  });

  it('classifies a real canonical diagnostic command without confirmation', () => {
    const result = new RiskClassifier().assess('df -h');
    expect(result).toMatchObject({
      tier: 0,
      decision: 'allow',
      requiresConfirmation: false,
    });
  });
});

describe('safe-bin profiles accept common real-world argument forms', () => {
  const accept: readonly (readonly [string, string[]])[] = [
    // Old-style POSIX attached digit values: `head -40` means `head -n 40`.
    ['head', ['head', '-40', '/repo/README.md']],
    ['head', ['head', '-n', '40', '/repo/README.md']],
    ['head', ['head', '/repo/README.md']],
    ['tail', ['tail', '-50', '/tmp/app.log']],
    ['tail', ['tail', '-n', '50', '/tmp/app.log']],
    ['tail', ['tail', '-f', '/tmp/app.log']],
    // Attached short-option value: `cut -d:`.
    ['cut', ['cut', '-d:', '-f1', '/repo/package.json']],
    ['wc', ['wc', '-l', '/repo/package.json']],
    ['uniq', ['uniq', '-c', '/tmp/hosts']],
    ['tr', ['tr', '-d', '\\r', '<', '/tmp/hosts']],
    // Systemd resource viewer with its own iteration flags.
    ['systemd-cgtop', ['systemd-cgtop', '-n', '1']],
    ['systemd-cgtop', ['systemd-cgtop', '-b']],
    ['systemd-cgtop', ['systemd-cgtop', '-1']],
    ['systemd-cgtop', ['systemd-cgtop', '--depth=2']],
    // Network queries in their common shapes.
    ['ip', ['ip', 'route', 'show']],
    ['ip', ['ip', 'route', 'show', 'table', 'main']],
    ['ip', ['ip', '-4', 'addr', 'show']],
    ['ps', ['ps', 'aux', '--sort=-%cpu']],
    ['df', ['df', '-hT', '/home']],
    ['du', ['du', '-h', '--max-depth=1', '/repo']],
    ['journalctl', ['journalctl', '-u', 'nginx', '-n', '20', '--no-pager']],
  ];

  for (const [name, argv] of accept) {
    it(`accepts ${name} ${argv.slice(1).join(' ')}`, () => {
      expect(matchesSafeBinProfile(name, argv)).toBe(true);
    });
  }

  const reject: readonly (readonly [string, string[]])[] = [
    ['ip', ['ip', 'addr', 'add', '10.0.0.1/24', 'dev', 'eth0']],
    ['ip', ['ip', 'link', 'set', 'eth0', 'down']],
    ['ip', ['ip', 'route', 'flush']],
    ['journalctl', ['journalctl', '--vacuum-time=1s']],
    ['journalctl', ['journalctl', '--rotate']],
    ['journalctl', ['journalctl', '--flush']],
    ['upower', ['upower', 'set', 'dpms', 'off']],
  ];

  for (const [name, argv] of reject) {
    it(`still rejects ${name} ${argv.slice(1).join(' ')}`, () => {
      expect(matchesSafeBinProfile(name, argv)).toBe(false);
    });
  }

  it('classifies head -40 as Tier 0 rather than requiring approval', () => {
    const result = new RiskClassifier().assess('head -40 README.md');
    expect(result).toMatchObject({
      tier: 0,
      requiresConfirmation: false,
    });
  });
});
