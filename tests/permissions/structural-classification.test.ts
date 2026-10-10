import { describe, expect, it } from 'vitest';
import { RiskClassifier } from '../../src/permissions/risk-classifier.js';
import { extractShellStructure } from '../../src/permissions/shell-structure.js';
import type { PermissionRule } from '../../src/permissions/rules.schema.js';

function assess(command: string) {
  return new RiskClassifier().assess(command);
}

describe('structural shell classification', () => {
  it.each([
    ['ls -la', 0, 'allow'],
    ['df -h', 0, 'allow'],
    ['git status', 0, 'allow'],
    ['cat somefile.txt', 0, 'allow'],
    ['ls | grep foo', 0, 'allow'],
    // npm runs scripts and lifecycle hooks from the repository, so the
    // chain asks even though `git status` on its own is read-only.
    ['git status && npm test', 2, 'ask'],
    ['cat file.txt | sort', 0, 'allow'],
    ['cat file.txt && rm -rf build', 2, 'ask'],
    ['echo x > existing-file', 3, 'allow'],
    ['sudo systemctl restart sshd', 2, 'ask'],
    ['rm -rf /', 1, 'deny'],
    ['unknown-wrapper --execute-something', 2, 'ask'],
  ] as const)('classifies %s as tier %i / %s', (command, tier, decision) => {
    const result = assess(command);
    expect(result.tier).toBe(tier);
    expect(result.decision).toBe(decision);
    expect(result.requiresConfirmation).toBe(decision === 'ask' && tier === 2);
  });

  it('does not downgrade a destructive outer command because its substitution is safe', () => {
    const result = assess('rm -rf $(some-safe-lookup)');

    expect(result.tier).toBe(2);
    expect(result.decision).toBe('ask');
    expect(result.matchedRule.id).toBe('ask-rm-force-recursive');
  });

  it('raises the aggregate tier for nested and compound hard denies', () => {
    expect(assess('echo $(rm -rf /)')).toMatchObject({
      tier: 1,
      decision: 'deny',
    });
    expect(assess('echo ok; rm -rf /')).toMatchObject({
      tier: 1,
      decision: 'deny',
    });
    expect(assess('echo `mkfs.ext4 /dev/sdb1`')).toMatchObject({
      tier: 1,
      decision: 'deny',
    });
  });

  it('traverses arithmetic for-loop expressions', () => {
    expect(
      assess('for ((i=$(unknown-wrapper); i<1; i++)); do echo ok; done'),
    ).toMatchObject({ tier: 2, decision: 'ask' });
    expect(
      assess('for ((i=$(rm -rf /); i<1; i++)); do echo ok; done'),
    ).toMatchObject({ tier: 1, decision: 'deny' });
  });

  it('keeps hard denies inside supported control-flow constructs', () => {
    expect(assess('if true; then rm -rf /; fi')).toMatchObject({
      tier: 1,
      decision: 'deny',
    });
    expect(assess('for file in *; do rm -rf /; done')).toMatchObject({
      tier: 1,
      decision: 'deny',
    });
  });

  it('fails closed when nested substitution syntax cannot be parsed', () => {
    const result = assess('echo $(unknown syntax ;;)');

    expect(result).toMatchObject({ tier: 2, decision: 'ask' });
    expect(result.matchedRule.id).toBe('ask-unknown-command');
  });

  it('preserves quoted and escaped operators inside one simple command', () => {
    expect(assess("echo 'a | b' && printf ok")).toMatchObject({
      tier: 0,
      decision: 'allow',
    });
    expect(assess('printf "a \\| b"')).toMatchObject({
      tier: 0,
      decision: 'allow',
    });
  });

  it('detects file writes even when the redirect target contains slashes', () => {
    expect(assess('echo x > /tmp/existing-file')).toMatchObject({
      tier: 3,
      decision: 'allow',
      requiresConfirmation: false,
    });
  });

  it('takes the highest informational tier from a safe pipeline', () => {
    expect(assess('echo x > existing-file | cat')).toMatchObject({
      tier: 3,
      decision: 'allow',
      requiresConfirmation: false,
    });
  });

  it('classifies safe process substitutions recursively', () => {
    expect(assess('diff <(cat left.txt) <(cat right.txt)')).toMatchObject({
      tier: 0,
      decision: 'allow',
    });
  });

  it('fails closed for unsupported heredoc traversal and dynamic executables', () => {
    expect(assess('cat <<EOF\nhello\nEOF')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
    expect(assess('$COMMAND --anything')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
  });

  it('preserves whole-command user restrictions after segmentation', () => {
    const userAsk: PermissionRule = {
      id: 'ask-git-test-chain',
      pattern: 'git status && npm test',
      decision: 'ask',
      tier: 2,
      description: 'This command chain requires confirmation.',
    };
    const userDeny: PermissionRule = {
      id: 'deny-cat-chain',
      pattern: 'ls | cat secret.txt',
      decision: 'deny',
      tier: 1,
      description: 'This command chain is blocked.',
    };
    const classifier = new RiskClassifier({ userRules: [userAsk, userDeny] });

    expect(classifier.assess('git status && npm test')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
    expect(classifier.assess('ls | cat secret.txt')).toMatchObject({
      tier: 1,
      decision: 'deny',
    });
  });

  it('treats find execution helpers as unknown operations', () => {
    expect(assess('find . -maxdepth 1 -type f')).toMatchObject({
      tier: 0,
      decision: 'allow',
    });
    expect(assess('find . -name "*.tmp" -exec rm {} +')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
  });

  it('normalizes only canonical system executable paths', () => {
    expect(assess('/bin/ls -la')).toMatchObject({ tier: 0, decision: 'allow' });
    expect(assess('/usr/bin/git status')).toMatchObject({
      tier: 0,
      decision: 'allow',
    });
    expect(assess('/tmp/ls -la')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
    expect(assess('./git status')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
    expect(assess('env rm -rf build')).toMatchObject({
      tier: 2,
      decision: 'ask',
    });
  });
});

describe('extractShellStructure', () => {
  it('extracts pipeline and logical stages from the AST', () => {
    expect(extractShellStructure('ls | grep foo').commands).toEqual([
      expect.objectContaining({ source: 'ls', executable: 'ls' }),
      expect.objectContaining({ source: 'grep foo', executable: 'grep' }),
    ]);
    expect(
      extractShellStructure('git status && npm test').commands.map(
        (segment) => segment.source,
      ),
    ).toEqual(['git status', 'npm test']);
  });

  it('marks malformed and unsupported structures unknown', () => {
    expect(extractShellStructure('echo $(unknown syntax ;;)').unknown).toBe(
      true,
    );
    expect(extractShellStructure('cat <<EOF\nhello\nEOF').unknown).toBe(true);
  });
});
