import { PermissionError } from '../errors.js';
import type { PermissionDecision, PermissionRule } from './rules.schema.js';

/** Result of evaluating the rule engine. */
export interface RuleEvaluation {
  /** Effective permission action. */
  decision: PermissionDecision;
  /** The first rule selected by deny, then ask, then allow precedence. */
  matchedRule: PermissionRule;
}

function commandGlobRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 's');
}

/** Matches a full command against a shell-oriented glob pattern. */
export function commandMatchesPattern(
  command: string,
  pattern: string,
): boolean {
  try {
    return commandGlobRegExp(pattern).test(command.trim());
  } catch {
    return false;
  }
}

/** Evaluates hard denies and configurable rules in strict precedence order. */
export class RuleEngine {
  readonly #hardDenyRules: readonly PermissionRule[];
  readonly #rules: readonly PermissionRule[];

  public constructor(
    rules: readonly PermissionRule[],
    hardDenyRules: readonly PermissionRule[] = [],
  ) {
    this.#hardDenyRules = hardDenyRules;
    this.#rules = rules;
  }

  /** Returns deny, then ask, then allow; undefined means default Tier 0. */
  public evaluate(command: string): RuleEvaluation | undefined {
    const normalized = command.trim();
    if (normalized === '') {
      throw new PermissionError('Cannot evaluate an empty shell command.');
    }

    const hardDeny = this.#firstMatch(normalized, this.#hardDenyRules, 'deny');
    if (hardDeny !== undefined) return hardDeny;

    const deny = this.#firstMatch(normalized, this.#rules, 'deny');
    if (deny !== undefined) return deny;

    const ask = this.#firstMatch(normalized, this.#rules, 'ask');
    if (ask !== undefined) return ask;

    return this.#firstMatch(normalized, this.#rules, 'allow');
  }

  #firstMatch(
    command: string,
    rules: readonly PermissionRule[],
    decision: PermissionDecision,
  ): RuleEvaluation | undefined {
    for (const rule of rules) {
      if (
        rule.decision === decision &&
        commandMatchesPattern(command, rule.pattern)
      ) {
        return { decision, matchedRule: rule };
      }
    }
    return undefined;
  }
}
