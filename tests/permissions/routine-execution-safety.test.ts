import { describe, expect, it } from 'vitest';
import {
  RiskClassifier,
  readsSensitivePath,
} from '../../src/permissions/risk-classifier.js';

/**
 * These lock in the fix for a real hole: the "routine command" allowlist used
 * to include tools that execute repository code or write to disk, and the
 * Tier 0 fallback approved them with no prompt. `npm run build` was proven to
 * execute arbitrary code from package.json with zero confirmations.
 */
describe('code execution is never auto-approved', () => {
  const classifier = new RiskClassifier();

  const mustAsk = [
    'npm run build',
    'npm test',
    'npm install',
    'make',
    'make install',
    'vitest run',
    'tsc --noEmit',
    'npx tsx script.ts',
    'node script.js',
    'python3 script.py',
    'sh -c "npm test"',
    'npm run build && rm -rf build',
  ];

  for (const command of mustAsk) {
    it(`asks before ${JSON.stringify(command)}`, () => {
      const result = classifier.assess(command);
      expect(result.requiresConfirmation || result.decision === 'deny').toBe(
        true,
      );
    });
  }
});

describe('filesystem mutation is never auto-approved', () => {
  const classifier = new RiskClassifier();

  const mustAsk = [
    'cp a b',
    'cp -r /home/titan/.ssh /tmp/x',
    'mkdir newdir',
    'touch newfile',
    'chmod +x script.sh',
    'chown user file',
    'tee output.txt',
    'sort -o data.txt data.txt',
    'mv a b',
    'systemctl restart nginx',
    'systemctl status nginx',
    'truncate -s 0 file',
    'ln -s /etc/passwd /tmp/pw',
  ];

  for (const command of mustAsk) {
    it(`asks before ${JSON.stringify(command)}`, () => {
      const result = classifier.assess(command);
      expect(result.requiresConfirmation || result.decision === 'deny').toBe(
        true,
      );
    });
  }
});

describe('read-only work still runs unattended', () => {
  const classifier = new RiskClassifier();

  const autoOk = [
    'ls -la',
    'cat README.md',
    'cat src/index.ts',
    'grep -rn todo .',
    'head -40 package.json',
    'find . -name "*.ts"',
    'git status',
    'git log --oneline -5',
    'git diff',
    'git show HEAD',
    'sort data.txt',
    'wc -l file',
    'du -sh .',
    'df -h',
    'ps aux --sort=-%cpu',
  ];

  for (const command of autoOk) {
    it(`allows ${JSON.stringify(command)} without a prompt`, () => {
      const result = classifier.assess(command);
      expect(result.tier).toBe(0);
      expect(result.requiresConfirmation).toBe(false);
    });
  }
});

describe('git is limited to read-only subcommands', () => {
  const classifier = new RiskClassifier();

  const mutating = [
    'git push',
    'git push origin main',
    'git commit -m x',
    'git merge feature',
    'git rebase main',
    'git checkout -b new',
    'git reset --hard HEAD',
    'git clean -fd',
    'git config core.pager evil',
    'git fetch origin',
    'git submodule update',
    'git stash',
  ];

  for (const command of mutating) {
    it(`asks before ${JSON.stringify(command)}`, () => {
      const result = classifier.assess(command);
      expect(result.requiresConfirmation || result.decision === 'deny').toBe(
        true,
      );
    });
  }
});

describe('secret reads are not auto-approved', () => {
  const classifier = new RiskClassifier();

  const secrets = [
    'cat ~/.ssh/id_rsa',
    'cat ~/.ssh/id_ed25519',
    'cat /home/titan/.ssh/config',
    'cat ~/.aws/credentials',
    'cat ~/.netrc',
    'cat ~/.npmrc',
    'cat .env',
    'cat .env.production',
    'head -20 cert.pem',
    'cat server.key',
    'cat /etc/shadow',
    'sudo cat /etc/shadow',
  ];

  for (const command of secrets) {
    it(`asks before ${JSON.stringify(command)}`, () => {
      const result = classifier.assess(command);
      expect(result.requiresConfirmation).toBe(true);
    });
  }

  it('does not fire on ordinary files that merely look similar', () => {
    for (const command of [
      'cat src/keyboard.ts',
      'cat lib/keystore.ts',
      'cat docs/environment.md',
      'cat .envrc.example',
      'cat src/index.ts',
      'cat .github/workflows/ci.yml',
    ]) {
      const result = classifier.assess(command);
      expect(result.tier, command).toBe(0);
    }
  });

  it('exposes the detector for reuse', () => {
    expect(readsSensitivePath('cat ~/.ssh/id_rsa')).toBe(true);
    expect(readsSensitivePath('cat README.md')).toBe(false);
  });
});

describe('the secret gate cannot be bypassed by a grant', () => {
  it('asks even when an exact grant exists for the same argv', () => {
    const granted = {
      id: 'g1',
      executablePath: '/usr/bin/cat',
      argv: ['cat', '/home/titan/.ssh/id_rsa'],
      cwd: '/home/titan',
      createdAt: new Date().toISOString(),
    };
    const classifier = new RiskClassifier({
      grantMatcher: {
        match: () => granted,
      },
    });
    const result = classifier.assess(
      'cat /home/titan/.ssh/id_rsa',
      '/home/titan',
    );
    expect(result.requiresConfirmation).toBe(true);
  });
});
