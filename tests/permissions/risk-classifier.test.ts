import { describe, expect, it } from 'vitest';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';

describe('RiskClassifier', () => {
  it('allows routine commands without requiring confirmation', () => {
    const classifier = new RiskClassifier();
    const commands = ['ls -la', 'df -h', 'git status', 'cat somefile.txt'];

    for (const command of commands) {
      expect(classifier.assess(command)).toMatchObject({
        tier: 0,
        decision: 'allow',
        requiresConfirmation: false,
      });
    }
  });

  it('classifies representative commands across all tiers', () => {
    const classifier = new RiskClassifier({ sudoWhitelistInstalled: true });
    const cases: [string, number, string][] = [
      ['ls -la', 0, 'allow'],
      // A commit runs repository hooks, which can execute arbitrary code.
      ['git commit -m "test"', 2, 'ask'],
      ['git status', 0, 'allow'],
      ['git log --oneline', 0, 'allow'],
      ['rm -rf ./node_modules', 2, 'ask'],
      ['rm -rf /', 1, 'deny'],
      ['rm -rf /tmp/workspace', 2, 'ask'],
      ['dd if=/dev/zero of=/dev/sda', 1, 'deny'],
      ['mkfs.ext4 /dev/sdb1', 1, 'deny'],
      ['systemctl stop sshd', 2, 'ask'],
      ['git push origin main --force', 2, 'ask'],
      ['echo x > /etc/hosts', 3, 'allow'],
      // Deleting every match is irreversible, so it asks rather than
      // relying on the informational tier-3 auto-approval.
      ['find . -type f -delete', 2, 'ask'],
    ];

    for (const [command, tier, decision] of cases) {
      const result = classifier.assess(command);
      expect([command, result.tier, result.decision]).toEqual([
        command,
        tier,
        decision,
      ]);
    }
  });

  it('only pre-approves narrow safe dnf package commands', () => {
    const classifier = new RiskClassifier({ sudoWhitelistInstalled: true });

    expect(classifier.assess('dnf install htop')).toMatchObject({
      tier: 0,
      decision: 'allow',
    });
    expect(classifier.assess('sudo dnf install htop')).toMatchObject({
      tier: 0,
      decision: 'allow',
    });
    expect(classifier.assess('dnf install --nogpgcheck htop')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
    expect(classifier.assess('dnf install ./local.rpm')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
    expect(
      classifier.assess('dnf install htop && rm -rf /tmp/x'),
    ).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
  });

  it('requires setup before allowing sudo package management', () => {
    const classifier = new RiskClassifier({ sudoWhitelistInstalled: false });
    const result = classifier.assess('sudo dnf install htop');

    expect(result).toMatchObject({
      tier: 2,
      decision: 'ask',
      sudoSetupRequired: true,
      requiresConfirmation: true,
    });
  });

  it('gates compound commands instead of allowing hidden dangerous segments', () => {
    const result = new RiskClassifier().assess(
      'echo safe; rm -rf /tmp/workspace',
    );

    expect(result.tier).toBe(2);
    expect(result.decision).toBe('ask');
  });

  it('does not classify scoped node_modules deletion as a hard deny', () => {
    const result = new RiskClassifier().assess('rm -rf ./node_modules');

    expect(result.tier).toBe(2);
    expect(result.decision).toBe('ask');
    expect(result.matchedRule.id).toBe('ask-rm-force-recursive');
  });
});
