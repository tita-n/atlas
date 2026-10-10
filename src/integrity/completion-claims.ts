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

// A target is any run of non-space, non-quoting characters, so a path written
// in a non-ASCII script is still a target rather than something the regex
// silently drops. `\w` would quietly skip those and lose the claim entirely.
const ARTIFACT =
  /\b(?:wrote|created|added|saved|generated|made)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?[`"']?((?:[^\s`'()[\]{},;:!?])+\.[a-z]{1,6})[`"']?/gi;
const ACTION_READ =
  /\b(?:read|opened|inspected|cat(?:'d)?)\s+(?:the\s+|a\s+|an\s+)?[`"']?([^\s`'()[\]{},;:!?]+)/gi;
const ACTION_RUN =
  /\b(?:ran|runs|executed|started)\s+(?:the\s+|a\s+|an\s+)?[`"']?((?:[^\s`'()[\]{},;:!?]+)(?:\s+(?:[^\s`'()[\]{},;:!?]+)){0,2})/gi;
const TESTS =
  /\b(?:all\s+)?(\d+\s+)?tests?\s+(?:pass|passed|succeed(?:ed)?)\b/i;

/**
 * Words that mean the claim belongs to somebody else, not to this turn.
 *
 * "The previous agent said 'I wrote src/app.ts'" is a quote, not a claim, and
 * verifying it against this turn's record credits the turn for work it never
 * did.
 */
const ATTRIBUTED =
  /\b(?:said|says|claimed|claims|insisted|insists|allegedly|according to)\b/i;

/** Cues that invert what follows them. */
const NEGATED =
  /\b(?:not|never|no|none|nothing|without|cannot|can't|won't|wouldn't|couldn't|didn't|doesn't|don't|isn't|wasn't|weren't|hasn't|haven't|hadn't|shouldn't|could\s+not|did\s+not|does\s+not|do\s+not|can\s+not|will\s+not|would\s+not)\b/i;

/**
 * Where a negation or an attribution stops applying.
 *
 * Without this, "I did not run the tests, but I did write src/app.ts" would
 * carry the first clause's negation over into the second.
 */
const CLAUSE_BOUNDARY =
  /[,;:!?]|\b(?:but|and|or|so|because|though|although|however|while|whereas)\b/i;

/**
 * How far back a negation or attribution can reach.
 *
 * Bounded on purpose: the text before a match is re-read for every match, and
 * a window keeps extraction linear in the length of the message instead of
 * quadratic in its claim count.
 */
const CONTEXT_REACH = 120;

/**
 * Grammar around the target rather than the target.
 *
 * "I ran the deploy script" names `deploy script`; without this the captured
 * word is `the`, which matches half of every command line ever recorded.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'a',
  'again',
  'all',
  'an',
  'and',
  'are',
  'at',
  'back',
  'be',
  'been',
  'being',
  'but',
  'by',
  'did',
  'do',
  'does',
  'down',
  'everything',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'our',
  'out',
  'she',
  'so',
  'some',
  'that',
  'the',
  'their',
  'them',
  'these',
  'they',
  'this',
  'those',
  'thing',
  'things',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your',
]);

/** Commands whose purpose is to put a file on disk. */
const WRITE_COMMAND =
  /\b(touch|mkdir|tee|install|cp|mv|rsync|dd|truncate|patch|git apply|git checkout|git restore)\b|>>?\s*\S/;

/**
 * Path-like tokens a successful write command mentions.
 *
 * Lets a real turn settle a "wrote x" claim from what it actually ran. Without
 * this every artifact claim stays inconclusive, and the gate would append a
 * "could not verify" note to almost every ordinary completion - technically
 * fail-closed, practically noise that trains people to ignore it.
 */
export function writtenPathsFrom(
  commands: readonly { readonly command: string; readonly ok: boolean }[],
): readonly string[] {
  const written = new Set<string>();
  for (const entry of commands) {
    // Only a command that actually succeeded wrote anything.
    if (!entry.ok) continue;
    if (!WRITE_COMMAND.test(entry.command)) continue;
    for (const token of entry.command.split(/\s+/)) {
      const cleaned = token.replace(/^["'`]|["'`]$/g, '').trim();
      if (cleaned === '' || !/[/.]/.test(cleaned)) continue;
      if (cleaned.startsWith('-')) continue;
      written.add(cleaned);
    }
  }
  return [...written];
}

/** Commands that constitute actually running a test suite. */
const TEST_RUNNER =
  /\b(vitest|jest|pytest|npm (run )?test|go test|cargo test|nx test)\b/;

/** Opening or closing fence of a markdown code block. */
const FENCE = /^\s*(?:`{3,}|~{3,})/;

/**
 * Blanks out fenced code blocks, keeping every character position.
 *
 * A patch shown in a code fence contains the words "wrote src/app.ts" without
 * asserting anything about the world, and matching inside it turns a diff into
 * a completion claim. Spaces preserve offsets and line numbers, so the claim
 * text and line still point at the real message.
 */
function maskFencedBlocks(narration: string): string {
  let open = false;
  return narration
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        open = !open;
        return ' '.repeat(line.length);
      }
      return open ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

/** The clause a match sits in, with the rest of the line discarded. */
function clauseTail(prefix: string): string {
  const parts = prefix.split(CLAUSE_BOUNDARY);
  return parts[parts.length - 1] ?? prefix;
}

function isNegated(prefix: string): boolean {
  return NEGATED.test(clauseTail(prefix));
}

function isAttributed(prefix: string): boolean {
  return ATTRIBUTED.test(clauseTail(prefix));
}

/** Trailing sentence punctuation that is not part of a filename's extension. */
const TRAILING_DOT = /\.$/u;
const EXTENSION = /\.[a-z]{1,6}$/iu;

/**
 * The command or path a claim names, stripped of the grammar around it.
 *
 * Returns undefined when the claim named nothing checkable - "I ran the" - so
 * the caller records an unresolvable claim rather than scoring a filler word.
 */
function normalizeActionTarget(raw: string): string | undefined {
  const tokens = raw
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '' && !FILLER_WORDS.has(token.toLowerCase()));
  if (tokens.length === 0) return undefined;
  const last = tokens[tokens.length - 1];
  const trimmed =
    last !== undefined && !EXTENSION.test(last)
      ? last.replace(TRAILING_DOT, '')
      : last;
  return [...tokens.slice(0, -1), trimmed ?? ''].join(' ').trim();
}

/**
 * Extracts the concrete claims in a completion message.
 *
 * A message with no checkable claim yields a single `vague` claim rather than
 * no claims, so "done" on its own is flagged as suspicious instead of passing
 * by default.
 */
export function extractClaims(narration: string): Claim[] {
  const claims: Claim[] = [];
  const scanned = maskFencedBlocks(narration);
  const lines = scanned.split('\n');
  const seen = new Set<string>();

  const add = (claim: Claim): void => {
    // The same fragment can match two patterns - "ran cat x" is both a run
    // and a read - and a doubled claim doubles the annotation for no gain.
    // Keyed in a set rather than scanned for, so extraction stays linear in
    // the size of the message.
    const key = `${claim.kind}|${claim.target ?? ''}|${claim.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push(claim);
  };

  lines.forEach((line, index) => {
    let match: RegExpExecArray | null;
    // Text before the match decides whether this is a claim at all.
    let prefix: string;

    ARTIFACT.lastIndex = 0;
    while ((match = ARTIFACT.exec(line)) !== null) {
      prefix = line.slice(
        Math.max(0, match.index - CONTEXT_REACH),
        match.index,
      );
      if (isNegated(prefix) || isAttributed(prefix)) continue;
      add({
        kind: 'artifact',
        text: match[0].trim(),
        target: match[1],
        line: index,
      });
    }

    ACTION_READ.lastIndex = 0;
    while ((match = ACTION_READ.exec(line)) !== null) {
      prefix = line.slice(
        Math.max(0, match.index - CONTEXT_REACH),
        match.index,
      );
      if (isNegated(prefix) || isAttributed(prefix)) continue;
      const target = normalizeActionTarget(match[1] ?? '');
      add({
        kind: 'action',
        text: match[0].trim(),
        ...(target === undefined ? {} : { target }),
        line: index,
      });
    }

    ACTION_RUN.lastIndex = 0;
    while ((match = ACTION_RUN.exec(line)) !== null) {
      prefix = line.slice(
        Math.max(0, match.index - CONTEXT_REACH),
        match.index,
      );
      if (isNegated(prefix) || isAttributed(prefix)) continue;
      const target = normalizeActionTarget(match[1] ?? '');
      add({
        kind: 'action',
        text: match[0].trim(),
        ...(target === undefined ? {} : { target }),
        line: index,
      });
    }

    TESTS.lastIndex = 0;
    if ((match = TESTS.exec(line)) !== null) {
      prefix = line.slice(
        Math.max(0, match.index - CONTEXT_REACH),
        match.index,
      );
      if (!isNegated(prefix) && !isAttributed(prefix)) {
        add({
          kind: 'tests',
          text: match[0].trim(),
          ...(match[1] === undefined ? {} : { target: match[1].trim() }),
          line: index,
        });
      }
    }
  });

  // A message that asserts completion without a single checkable claim.
  const assertsCompletion =
    /\b(done|complete[d]?|finished|all set|that'?s it|that'?s that|ready)\b/i.test(
      scanned,
    );
  if (claims.length === 0 && assertsCompletion) {
    claims.push({
      kind: 'vague',
      text: scanned.trim().replace(/\s+/gu, ' ').slice(0, 120),
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

/** A match that cannot land inside a longer word, where one is meaningful. */
function wordMatcher(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/u.test(token) ? '\\b' : '';
  const right = /\w$/u.test(token) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, 'i');
}

/**
 * Whether a target names something a command line could actually contain.
 *
 * A bare English word ("config", "deploy script") cannot be located in a
 * command without guessing, and guessing here is how a fabricated action turns
 * into a pass. Unlocatable targets stay inconclusive instead.
 */
function isCommandShaped(target: string): boolean {
  return /[./\-_@\s]/u.test(target) || TEST_RUNNER.test(target);
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
        if (!isCommandShaped(target)) {
          verdicts.set(claim, 'inconclusive');
          break;
        }
        const needle = basename(target);
        const exact = wordMatcher(target);
        const loose = wordMatcher(needle);
        const hit = transcript.commands.some(
          (command) => exact.test(command) || loose.test(command),
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
    case 'action':
      // No probe: re-running a suite is not a re-read of state, it is a second
      // execution with its own effects. A tests claim with no recorded outcome
      // stays inconclusive, which is what it is.
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
  const quote = (claim: Claim): string =>
    claim.text.trim() === '' ? `(${claim.kind} claim)` : claim.text;
  if (report.failures.length > 0) {
    lines.push('Before calling this done, some claims did not hold up:');
    for (const claim of report.failures) {
      lines.push(`  - not supported by this turn's record: "${quote(claim)}"`);
    }
  }
  if (report.inconclusive.length > 0) {
    lines.push('Claims I could not verify independently:');
    for (const claim of report.inconclusive) {
      lines.push(`  - "${quote(claim)}" (no independent check available)`);
    }
  }
  lines.push('');
  lines.push('So treat the above as unconfirmed, not finished.');
  return `${lines.join('\n')}\n\n${narration}`;
}
