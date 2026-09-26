import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_RULES,
  HARD_DENY_RULES,
} from '../../src/permissions/default-rules.js';
import {
  RuleEngine,
  commandMatchesPattern,
} from '../../src/permissions/rule-engine.js';
import type { PermissionRule } from '../../src/permissions/rules.schema.js';

describe('RuleEngine', () => {
  it('matches glob-style command patterns', () => {
    expect(commandMatchesPattern('rm -rf ./node_modules', 'rm -rf **')).toBe(
      true,
    );
    expect(commandMatchesPattern('sudo dnf install htop', 'sudo **')).toBe(
      true,
    );
    expect(commandMatchesPattern('echo hi', 'rm **')).toBe(false);
  });

  it('always evaluates hard deny before user allow rules', () => {
    const userAllow: PermissionRule = {
      id: 'user-allow-root-delete',
      pattern: 'rm -rf /',
      decision: 'allow',
      tier: 0,
      description: 'Attempted user override.',
    };
    const engine = new RuleEngine(
      [...DEFAULT_PERMISSION_RULES, userAllow],
      HARD_DENY_RULES,
    );

    expect(engine.evaluate('rm -rf /')).toMatchObject({
      decision: 'deny',
      matchedRule: { id: 'hard-deny-rm-root' },
    });
  });

  it('does not let a user allow rule override a built-in ask rule', () => {
    const userAllow: PermissionRule = {
      id: 'user-allow-node-delete',
      pattern: 'rm -rf ./node_modules',
      decision: 'allow',
      tier: 0,
      description: 'Attempted user override.',
    };
    const engine = new RuleEngine(
      [...DEFAULT_PERMISSION_RULES, userAllow],
      HARD_DENY_RULES,
    );

    expect(engine.evaluate('rm -rf ./node_modules')).toMatchObject({
      decision: 'ask',
      matchedRule: { id: 'ask-rm-force-recursive' },
    });
  });
});
