/**
 * Checking what Atlas says it did, before the user is told it is done.
 *
 * Research on this failure mode is consistent and unflattering: agents report
 * false success in roughly 45-48% of single-control failures and 75.8% among
 * self-assessing coding agents. The mechanism is consistent too - acting and
 * checking are the same step, so the agent reads a tool's return value and
 * infers success from it without ever looking at the world it just changed.
 *
 * So verification here is deliberately *not* the agent checking itself. Claims
 * are checked from outside the narrative, in ascending order of cost:
 *
 *   1. Transcript grounding. A claim about an action is provably false if no
 *      matching call appears in the turn. Free, and decisive for the most
 *      common fabrication: claiming work whose transcript shows it never
 *      happened.
 *   2. Independent probe. A claim about resulting state gets a read-only command
 *      that re-reads the real state, because a receipt can prove a call was
 *      recorded but never that the world changed as described.
 *
 * Verdicts are tri-state on purpose. `inconclusive` is a real outcome, and
 * collapsing it into `pass` is how an unverified claim becomes a fabricated
 * one.
 */

export type Verdict = 'pass' | 'fail' | 'inconclusive';

export type ClaimKind =
  /** "I ran the tests", "I read the config" - about actions taken. */
  | 'action'
  /** "I wrote src/x.ts" - about a file that should now exist. */
  | 'artifact'
  /** "All tests pass" - about a suite's result. */
  | 'tests'
  /** A completion claim with nothing checkable in it. */
  | 'vague';

export interface Claim {
  readonly kind: ClaimKind;
  /** The literal fragment the claim came from, for the report. */
  readonly text: string;
  /** A path, command, or suite name the claim names. */
  readonly target?: string | undefined;
  readonly line: number;
}

const ARTIFACT =
  /\b(?:wrote|created|added|saved|generated|made)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?[`"']?([\w./-]+\.[a-z]{1,6})[`"']?/gi;
const ACTION_READ =
  /\b(?:read|opened|inspected|cat(?:'d)?)\s+[`"']?([\w./-]+)[`"']?/gi;
const ACTION_RUN =
  /\b(?:ran|runs|executed|started)\s+[`"']?([\w ./@_-]+?)[`"']?(?=\s|[.,;!?]|$)/gi;
const TESTS =
  /\b(?:all\s+)?(\d+\s+)?tests?\s+(?:pass|passed|succeed(?:ed)?)\b/i;

/** Commands that constitute actually running a test suite. */
const TEST_RUNNER =
  /\b(vitest|jest|pytest|npm (run )?test|go test|cargo test|nx test)\b/;

/**
 * Extracts the concrete claims in a completion message.
 *
 * A message with no checkable claim yields a single `vague` claim rather than
 * no claims, so "done" on its own is flagged as suspicious instead of passing
 * by default.
 */
export function extractClaims(narration: string): Claim[] {
  const claims: Claim[] = [];
  const lines = narration.split('\n');

  lines.forEach((line, index) => {
    let match: RegExpExecArray | null;

    ARTIFACT.lastIndex = 0;
    while ((match = ARTIFACT.exec(line)) !== null) {
      claims.push({
        kind: 'artifact',
        text: match[0].trim(),
        target: match[1],
        line: index,
      });
    }

    ACTION_READ.lastIndex = 0;
    while ((match = ACTION_READ.exec(line)) !== null) {
      claims.push({
        kind: 'action',
        text: match[0].trim(),
        target: match[1],
        line: index,
      });
    }

    ACTION_RUN.lastIndex = 0;
    while ((match = ACTION_RUN.exec(line)) !== null) {
      const target = match[1]?.trim();
      if (target !== undefined && target !== '') {
        claims.push({
          kind: 'action',
          text: match[0].trim(),
          target,
          line: index,
        });
      }
    }

    TESTS.lastIndex = 0;
    if ((match = TESTS.exec(line)) !== null) {
      claims.push({
        kind: 'tests',
        text: match[0].trim(),
        ...(match[1] === undefined ? {} : { target: match[1].trim() }),
        line: index,
      });
    }
  });

  // A message that asserts completion without a single checkable claim.
  const assertsCompletion =
    /\b(done|complete[d]?|finished|all set|that'?s it|that'?s that|ready)\b/i.test(
      narration,
    );
  if (claims.length === 0 && assertsCompletion) {
    claims.push({
      kind: 'vague',
      text: narration.trim().slice(0, 120),
      line: 0,
    });
  }

  return claims;
}

/** What actually happened this turn, as recorded by the harness. */
export interface Transcript {
  /** Commands the shell tool ran. */
  readonly commands: readonly string[];
  /** Files written during the turn, if the harness recorded them. */
  readonly written?: readonly string[];
  /**
   * Exit outcomes for commands run this turn.
   *
   * Needed because a record that a suite ran says nothing about whether it
   * passed. Without outcomes, a "tests pass" claim is inconclusive rather than
   * assumed.
   */
  readonly outcomes?: readonly { command: string; ok: boolean }[];
}

function basename(target: string): string {
  const slash = target.lastIndexOf('/');
  return slash === -1 ? target : target.slice(slash + 1);
}

/**
 * Checks claims against the transcript - free, and decisive when it fails.
 *
 * This is the check that catches claiming work the turn's own record shows was
 * never done, which is the dominant form of the failure in self-assessing
 * coding agents.
 */
export function verifyAgainstTranscript(
  claims: readonly Claim[],
  transcript: Transcript,
): Map<Claim, Verdict> {
  const verdicts = new Map<Claim, Verdict>();
  for (const claim of claims) {
    if (claim.kind === 'vague') {
      verdicts.set(claim, 'fail');
      continue;
    }
    const target = claim.target;
    if (target === undefined || target === '') {
      // A tests claim with no count is still checkable: what matters is
      // whether a suite ran, not how many tests it reported.
      if (claim.kind !== 'tests') {
        verdicts.set(claim, 'inconclusive');
        continue;
      }
      const outcomes = transcript.outcomes;
      if (outcomes !== undefined) {
        const suite = outcomes.filter((outcome) =>
          TEST_RUNNER.test(outcome.command),
        );
        verdicts.set(
          claim,
          suite.length === 0
            ? 'fail'
            : suite.some((outcome) => outcome.ok)
              ? 'pass'
              : 'fail',
        );
      } else {
        verdicts.set(
          claim,
          transcript.commands.some((command) => TEST_RUNNER.test(command))
            ? 'inconclusive'
            : 'fail',
        );
      }
      continue;
    }
    switch (claim.kind) {
      case 'artifact': {
        const written = transcript.written;
        if (written !== undefined) {
          verdicts.set(claim, written.includes(target) ? 'pass' : 'fail');
          break;
        }
        // Without a write record, a written-file claim cannot be settled from
        // the transcript alone. It needs a probe, not a guess.
        verdicts.set(claim, 'inconclusive');
        break;
      }
      case 'action': {
        const needle = basename(target);
        const hit = transcript.commands.some(
          (command) => command.includes(target) || command.includes(needle),
        );
        verdicts.set(claim, hit ? 'pass' : 'fail');
        break;
      }
      case 'tests': {
        const outcomes = transcript.outcomes;
        if (outcomes === undefined) {
          // Ran is not the same as passed.
          verdicts.set(claim, 'inconclusive');
          break;
        }
        const suite = outcomes.filter((outcome) =>
          TEST_RUNNER.test(outcome.command),
        );
        if (suite.length === 0) {
          verdicts.set(claim, 'fail');
          break;
        }
        verdicts.set(
          claim,
          suite.some((outcome) => outcome.ok) ? 'pass' : 'fail',
        );
        break;
      }
      default:
        verdicts.set(claim, 'inconclusive');
    }
  }
  return verdicts;
}

/**
 * A read-only command that re-reads the real state for a claim.
 *
 * Read-only on purpose: verification that can change the world is not
 * verification. A claim with no probe stays inconclusive rather than being
 * checked by something that might itself alter what is being checked.
 */
export function probeFor(claim: Claim): string | undefined {
  const target = claim.target;
  switch (claim.kind) {
    case 'artifact':
      return target === undefined ? undefined : `test -e ${quote(target)}`;
    case 'tests':
      return 'npm test';
    case 'action':
      // No general probe: what "it ran" means depends entirely on the command.
      return undefined;
    default:
      return undefined;
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ProbeOutcome {
  readonly claim: Claim;
  readonly command: string;
  readonly ok: boolean;
}

export interface VerificationReport {
  /** Whether anything can honestly be called done. */
  readonly complete: boolean;
  readonly results: readonly {
    readonly claim: Claim;
    readonly verdict: Verdict;
  }[];
  /** Claims that were checked and did not hold. */
  readonly failures: readonly Claim[];
  /** Claims nobody could check, which is not the same as passing. */
  readonly inconclusive: readonly Claim[];
}

/**
 * Decides whether the completion message may stand, and produces what to say
 * instead when it may not.
 *
 * `complete` requires every checkable claim to have passed. A single failure
 * or an unresolvable claim is enough to withhold completion, because reporting
 * partial work accurately is cheap and reporting finished work that is not
 * finished is the failure this whole module exists to prevent.
 */
export function buildReport(input: {
  claims: readonly Claim[];
  transcript: Transcript;
  probe?: (claim: Claim) => ProbeOutcome | undefined;
}): VerificationReport {
  const transcriptVerdicts = verifyAgainstTranscript(
    input.claims,
    input.transcript,
  );
  const results = input.claims.map((claim) => {
    let verdict = transcriptVerdicts.get(claim) ?? 'inconclusive';
    if (verdict === 'inconclusive' && input.probe !== undefined) {
      const outcome = input.probe(claim);
      if (outcome !== undefined) verdict = outcome.ok ? 'pass' : 'fail';
    }
    return { claim, verdict };
  });

  const failures = results
    .filter((r) => r.verdict === 'fail')
    .map((r) => r.claim);
  const inconclusive = results
    .filter((r) => r.verdict === 'inconclusive')
    .map((r) => r.claim);

  return {
    // No claims at all is not a failure - the model may simply be reporting
    // rather than claiming. Claims that exist must all pass.
    complete: failures.length === 0 && inconclusive.length === 0,
    results,
    failures,
    inconclusive,
  };
}

/**
 * Rewrites a completion message when it cannot be trusted.
 *
 * Keeps the model's own narration - the user should see what it said - and
 * prepends an accurate account of what did not check out, so the correction is
 * additive rather than a silent substitution.
 */
export function annotateIfUnverified(
  narration: string,
  report: VerificationReport,
): string {
  if (report.complete) return narration;
  const lines: string[] = [];
  if (report.failures.length > 0) {
    lines.push('Before calling this done, some claims did not hold up:');
    for (const claim of report.failures) {
      lines.push(`  - not supported by this turn's record: "${claim.text}"`);
    }
  }
  if (report.inconclusive.length > 0) {
    lines.push('Claims I could not verify independently:');
    for (const claim of report.inconclusive) {
      lines.push(`  - "${claim.text}" (no independent check available)`);
    }
  }
  lines.push('');
  lines.push('So treat the above as unconfirmed, not finished.');
  return `${lines.join('\n')}\n\n${narration}`;
}
