import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../../src/audit/audit-log.js';
import { openDatabase } from '../../src/memory/database.js';
import { ConfirmationFlow } from '../../src/permissions/confirmation-flow.js';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';
import { ShellSession } from '../../src/shell/shell-session.js';
import { ShellTool } from '../../src/shell/shell-tool.js';
import {
  hasNativePreview,
  describeCommand,
  parseCommandLine,
  planDryRun,
} from '../../src/permissions/dry-run.js';

let session: ShellSession | undefined;

afterEach(() => {
  session?.close();
  session = undefined;
});

/** A shell tool whose "native preview" records what it was asked to run. */
function previewTool(executed: string[]): ShellTool {
  const active = new ShellSession({ timeoutMs: 5_000 });
  session = active;
  return new ShellTool({
    session: active,
    classifier: new RiskClassifier(),
    confirmation: new ConfirmationFlow({
      provider: {
        name: 'mock',
        chatCompletion: () =>
          Promise.resolve({ content: 'stub', model: 'mock' }),
      },
      model: 'mock',
      confirmText: () => Promise.resolve(false),
      wait: () => Promise.resolve(),
    }),
    auditLog: new AuditLog(openDatabase(':memory:')),
    gatePath: 'text-safe-word',
    dryRun: async (command: string) => {
      executed.push(command);
      const result = await active.execute(command);
      return result.stdout + result.stderr;
    },
  });
}

describe('dry-run planning', () => {
  it('uses a native preview where one is verified', () => {
    expect(planDryRun('rsync -av src/ dest/').command).toContain('--dry-run');
    expect(hasNativePreview('rsync -av src/ dest/')).toBe(true);
  });

  it('adds a preview flag git accepts, per subcommand', () => {
    expect(planDryRun('git clean -fd').command).toMatch(/--dry-run|-n/);
    expect(planDryRun('git push origin main').command).toContain('--dry-run');
    expect(planDryRun('git add .').method).toBe('native');
  });

  it('treats git with no previewable subcommand as static', () => {
    const plan = planDryRun('git rebase --onto main topic');
    expect(plan.method).toBe('static');
    expect(plan.caveat).toContain('no global dry-run');
  });

  it('NEVER treats cp -n as a preview', () => {
    // Regression with teeth: `cp -n` means "do not overwrite", NOT "do
    // nothing". It would still copy every non-colliding file.
    const plan = planDryRun('cp -n a.txt b.txt');
    expect(plan.method).toBe('static');
    expect(plan.caveat).toContain('do not overwrite');
  });

  it('NEVER treats mv -n or ln -n as a preview', () => {
    for (const command of ['mv -n a b', 'ln -n a b']) {
      expect(planDryRun(command).method).toBe('static');
    }
  });

  it('stays static for commands with no preview at all', () => {
    for (const command of [
      'rm -rf /tmp/x',
      'chmod 777 /etc',
      'dd if=/dev/zero of=/dev/sda',
    ]) {
      expect(planDryRun(command).method).toBe('static');
    }
  });

  it('warns that make -n is not a complete preview', () => {
    const plan = planDryRun('make build');
    expect(plan.method).toBe('native');
    expect(plan.caveat).toContain('can still execute');
  });

  it('leaves a command that is already previewing unchanged', () => {
    expect(planDryRun('rsync --dry-run a b').command).toBe(
      'rsync --dry-run a b',
    );
  });

  it('never appends a preview flag to a shell script', () => {
    // Regression with teeth: the flag would land on `cat`, running rsync for
    // real and previewing the wrong command.
    for (const command of [
      'rsync -av src/ dst/ | cat',
      'rsync -av --delete src/ dst/ && echo done',
      'rm -rf /tmp/x; echo gone',
      'make -n build > out.txt',
      'git clean -fd $(pwd)',
      'apt-get install -y foo || true',
    ]) {
      const plan = planDryRun(command);
      expect(plan.method, command).toBe('static');
      expect(plan.command, command).toBe(command);
      expect(plan.caveat, command).toContain('shell operator');
    }
  });

  it("does not mistake another command's -s flag for a preview", () => {
    // Regression with teeth: `kill -s TERM <pid>` sends a signal. Treating -s
    // as a preview flag runs it unchanged.
    expect(planDryRun('kill -s TERM 1234').method).toBe('static');
    expect(planDryRun('kill -s TERM 1234').command).toBe('kill -s TERM 1234');
    expect(planDryRun('chmod -s 755 f').method).toBe('static');
  });

  it('still recognises the preview flags a command actually owns', () => {
    expect(planDryRun('apt-get install -s foo').command).toBe(
      'apt-get install -s foo',
    );
    expect(planDryRun('make -n build').command).toBe('make -n build');
    expect(planDryRun('git clean -n -fd').command).toBe('git clean -n -fd');
  });

  it('never throws on an odd or empty command', () => {
    expect(planDryRun('').method).toBe('static');
    expect(planDryRun('   ').method).toBe('static');
    expect(planDryRun('!!!').method).toBe('static');
  });

  it('handles an absolute executable path', () => {
    expect(planDryRun('/usr/bin/rsync -av a b').method).toBe('native');
  });
});

describe('command parsing', () => {
  it('splits an executable from its arguments', () => {
    expect(parseCommandLine('ls -la /tmp')).toEqual({
      executable: 'ls',
      args: ['-la', '/tmp'],
    });
  });

  it('handles an empty command', () => {
    expect(parseCommandLine('   ')).toEqual({ executable: '', args: [] });
  });
});

describe('command description', () => {
  it('names destructive verbs in plain language', () => {
    expect(describeCommand('rm -rf /tmp/x')).toContain('permanently delete');
    expect(describeCommand('chmod 777 /etc')).toContain('change permissions');
  });

  it('falls back to a structural description it cannot improve on', () => {
    expect(describeCommand('frobnicate --fast x')).toContain('frobnicate');
  });

  it('describes an empty command honestly', () => {
    expect(describeCommand('')).toBe('an empty command');
  });
});

describe('preview side effects', () => {
  it('never executes the real command, proven on the filesystem', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-dryrun-'));
    const target = join(directory, 'target.txt');
    const executed: string[] = [];
    const tool = previewTool(executed);
    try {
      await writeFile(target, 'original\n');
      const before = statSync(directory).mode & 0o777;

      for (const command of [
        `touch ${join(directory, 'created-by-touch')}`,
        `rm -f ${target}`,
        `cp ${target} ${join(directory, 'copy-ran')}`,
        `mv ${target} ${join(directory, 'moved-ran')}`,
        `dd if=/dev/zero of=${join(directory, 'dd-ran')} bs=1 count=4`,
        `chmod 700 ${directory}`,
        `rsync -av ${directory}/ ${join(directory, 'rsync-ran')}/`,
        `rsync -av --delete ${directory}/ ${join(directory, 'piped')}/ | cat`,
        `git clean -fdx`,
        `make -n build`,
        `frobnicate --definitely-not-a-command`,
      ]) {
        await tool.execute({
          name: 'shell',
          arguments: { command, dryRun: true },
        } as never);
      }

      expect(existsSync(target), 'target must survive').toBe(true);
      for (const name of [
        'created-by-touch',
        'copy-ran',
        'moved-ran',
        'dd-ran',
        'rsync-ran',
        'piped',
      ]) {
        expect(existsSync(join(directory, name)), name).toBe(false);
      }
      expect(statSync(directory).mode & 0o777).toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
