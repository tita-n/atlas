import { describe, expect, it } from 'vitest';

import {
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY_LEVEL,
  confirmationPhraseFor,
  describeLevel,
  hardFloorVerdict,
  isAutonomyLevel,
  loadAutonomy,
  saveAutonomy,
  settingsPath,
  shouldAsk,
  type AutonomyLevel,
} from '../../src/permissions/autonomy.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = '/home/tester';

describe('levels', () => {
  it('starts at confirm-everything', () => {
    // The default must never change silently: it is the safe side.
    expect(DEFAULT_AUTONOMY_LEVEL).toBe('confirm-everything');
  });

  it('offers exactly three levels', () => {
    expect(AUTONOMY_LEVELS).toEqual([
      'confirm-everything',
      'scoped-approval',
      'unattended',
    ]);
  });

  it('requires friction for every level below the default', () => {
    expect(describeLevel('confirm-everything').requiresFriction).toBe(false);
    expect(describeLevel('scoped-approval').requiresFriction).toBe(true);
    expect(describeLevel('unattended').requiresFriction).toBe(true);
  });

  it('states what is being given up, plainly, for each level', () => {
    for (const level of AUTONOMY_LEVELS) {
      expect(describeLevel(level).risk.length).toBeGreaterThan(20);
    }
    expect(describeLevel('unattended').risk).toContain('yours to undo');
  });

  it('demands a distinct phrase for each lowered level', () => {
    expect(confirmationPhraseFor('unattended')).not.toBe(
      confirmationPhraseFor('scoped-approval'),
    );
    expect(confirmationPhraseFor('unattended')).toContain('UNATTENDED');
  });

  it('recognizes valid levels and rejects anything else', () => {
    expect(isAutonomyLevel('unattended')).toBe(true);
    expect(isAutonomyLevel('yolo')).toBe(false);
    expect(isAutonomyLevel(undefined)).toBe(false);
  });
});

describe('persistence', () => {
  it('defaults to confirm-everything when nothing is stored', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-autonomy-'));
    expect((await loadAutonomy(home)).level).toBe('confirm-everything');
  });

  it('persists a level until it is explicitly changed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-autonomy-'));
    await saveAutonomy(home, 'unattended', '2026-01-01T00:00:00.000Z');
    // A fresh load is a different code path from the in-memory value.
    expect((await loadAutonomy(home)).level).toBe('unattended');
    expect((await loadAutonomy(home)).changedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('fails SAFE on a corrupt settings file, not open', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-autonomy-'));
    await saveAutonomy(home, 'unattended');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(settingsPath(home), '{{{ not json', 'utf8');
    // A safety setting must never degrade to permissive on a parse failure.
    expect((await loadAutonomy(home)).level).toBe('confirm-everything');
  });

  it('fails safe when the stored level is not a known level', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-autonomy-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      settingsPath(home),
      JSON.stringify({ level: 'total-yolo', changedAt: 'x' }),
      'utf8',
    );
    expect((await loadAutonomy(home)).level).toBe('confirm-everything');
  });
});

describe('the hard floor', () => {
  const catastrophic: readonly string[] = [
    'rm -rf /',
    'rm -rf /*',
    'rm -fr /',
    'rm -rf ~',
    'rm -rf $HOME',
    `rm -rf ${HOME}`,
    'mkfs.ext4 /dev/sda1',
    'wipefs -a /dev/sdb',
    'shred -u /dev/sdc',
    'dd if=/dev/zero of=/dev/sda bs=1M',
  ];

  it.each(catastrophic)('always applies to %s', (command) => {
    expect(hardFloorVerdict(command, { home: HOME }).applies).toBe(true);
  });

  const selfMod: readonly string[] = [
    'rm /home/tester/.atlas/permissions.json',
    'echo x > ~/.atlas/autonomy.json',
    'sed -i s/ask/allow/ /home/tester/.atlas/src/permissions/default-rules.ts',
    'tee /etc/sudoers.d/anything',
    'chmod 666 /home/tester/.atlas/atlas.lock',
  ];

  it.each(selfMod)('always applies to self-modification: %s', (command) => {
    const verdict = hardFloorVerdict(command, { home: HOME });
    expect(verdict.applies).toBe(true);
    expect(verdict.category).toBe('self-modification');
  });

  const ordinary = [
    'ls -la',
    'rm -rf /tmp/build',
    'rm file.txt',
    'npm install',
    'git push origin main',
    'find . -name "*.log" -delete',
    'dd if=input.img of=output.img',
    '',
  ];

  it.each(ordinary)('does NOT apply to ordinary work: %s', (command) => {
    expect(hardFloorVerdict(command, { home: HOME }).applies).toBe(false);
  });

  it('does not fire on a non-recursive remove of a root-looking path', () => {
    // `rm /tmp/x` is not a filesystem wipe.
    expect(hardFloorVerdict('rm /tmp/x', { home: HOME }).applies).toBe(false);
  });
});

describe('confirmation frequency', () => {
  const ask = (level: AutonomyLevel, command = 'chmod 777 /etc') =>
    shouldAsk({ level, tier: 2, command, home: HOME });

  it('asks for everything at the default level', () => {
    expect(ask('confirm-everything')).toBe(true);
  });

  it('does not ask at the unattended level', () => {
    expect(ask('unattended')).toBe(false);
  });

  it('STILL asks at the unattended level for the hard floor', () => {
    // The whole point of the floor: this must never be skipped.
    for (const command of [
      'rm -rf /',
      'mkfs.ext4 /dev/sda1',
      'rm ~/.atlas/permissions.json',
    ]) {
      expect(ask('unattended', command)).toBe(true);
    }
  });

  it('STILL asks for the hard floor under scoped approval too', () => {
    for (const command of ['rm -rf /', 'rm -rf ~']) {
      expect(
        shouldAsk({
          level: 'scoped-approval',
          tier: 2,
          command,
          home: HOME,
          scopedCategories: ['filesystem'],
        }),
      ).toBe(true);
    }
  });

  it('asks for anything outside a declared scope', () => {
    const inScope = shouldAsk({
      level: 'scoped-approval',
      tier: 2,
      command: 'chmod 777 /etc',
      home: HOME,
      scopedCategories: ['filesystem'],
      category: 'filesystem',
    });
    expect(inScope).toBe(false);

    const outOfScope = shouldAsk({
      level: 'scoped-approval',
      tier: 2,
      command: 'systemctl stop nginx',
      home: HOME,
      scopedCategories: ['filesystem'],
      category: 'services',
    });
    expect(outOfScope).toBe(true);
  });

  it('treats an empty or missing scope as ask-everything', () => {
    // A scope that was never declared must not be read as "everything".
    expect(
      shouldAsk({
        level: 'scoped-approval',
        tier: 2,
        command: 'ls',
        home: HOME,
      }),
    ).toBe(true);
  });

  it('always asks when the scope cannot be determined', () => {
    expect(
      shouldAsk({
        level: 'scoped-approval',
        tier: 2,
        command: 'ls',
        home: HOME,
        scopedCategories: ['filesystem'],
      }),
    ).toBe(true);
  });
});
