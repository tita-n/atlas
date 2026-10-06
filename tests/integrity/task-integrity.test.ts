/**
 * Task-execution integrity: completion fabrication and the direct-path nudge.
 *
 * The fabrication tests use the dominant real-world shape - a turn that claims
 * work its own record does not contain - rather than contrived strings.
 */
import { describe, expect, it } from 'vitest';

import {
  annotateIfUnverified,
  type Claim,
  buildReport,
  extractClaims,
  probeFor,
  verifyAgainstTranscript,
  type Transcript,
} from '../../src/integrity/completion-claims.js';
import {
  DEFAULT_COMPLEXITY_THRESHOLD,
  estimateComplexity,
  planningNudge,
  shouldPlan,
} from '../../src/integrity/plan-first.js';

/**
 * The first claim of a kind, failing loudly rather than on undefined.
 *
 * Several tests need a specific claim out of a message that also produced
 * others, so selection is by kind rather than by position.
 */
function claimOfKind(text: string, kind: Claim['kind']): Claim {
  const found = extractClaims(text).find((claim) => claim.kind === kind);
  if (found === undefined) {
    throw new Error(`expected a ${kind} claim in ${JSON.stringify(text)}`);
  }
  return found;
}

function onlyClaim(text: string): Claim {
  const claims = extractClaims(text);
  const first = claims[0];
  if (first === undefined)
    throw new Error(`no claim in ${JSON.stringify(text)}`);
  return first;
}

describe('claim extraction', () => {
  it('pulls out concrete, checkable claims', () => {
    const claims = extractClaims(
      'I wrote src/app.ts, then I ran the tests and all 42 tests pass.',
    );
    const kinds = claims.map((claim) => claim.kind);
    expect(kinds).toContain('artifact');
    expect(kinds).toContain('action');
    expect(kinds).toContain('tests');
    expect(claims.find((c) => c.kind === 'artifact')?.target).toBe(
      'src/app.ts',
    );
  });

  it('treats a bare completion statement as suspicious on its own', () => {
    // "Done" with nothing checkable is the failure mode, not a pass.
    const claims = extractClaims('Done.');
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe('vague');
  });

  it('does not invent claims from a report with none', () => {
    // Reporting is not claiming; this should not be flagged as fabrication.
    expect(extractClaims('Here is what I found in the config file.')).toEqual(
      [],
    );
  });

  it('recognises the common vague phrasings', () => {
    for (const text of ['All done.', "That's it.", 'All set.']) {
      expect(extractClaims(text)[0]?.kind).toBe('vague');
    }
  });
});

describe('transcript grounding', () => {
  const transcript: Transcript = {
    commands: ['ls -la', 'npm test'],
    outcomes: [
      { command: 'ls -la', ok: true },
      { command: 'npm test', ok: true },
    ],
  };

  it('passes a claim the turn actually performed', () => {
    const claim = claimOfKind('I ran npm test and all tests pass.', 'tests');
    const verdicts = verifyAgainstTranscript([claim], transcript);
    expect(verdicts.get(claim)).toBe('pass');
  });

  it('fails a claim the turn never performed', () => {
    // The signature failure: claiming a suite this turn never ran.
    const claim = claimOfKind(
      'I ran the integration suite and all tests pass.',
      'tests',
    );
    const verdicts = verifyAgainstTranscript([claim], {
      commands: ['ls -la'],
      outcomes: [{ command: 'ls -la', ok: true }],
    });
    expect(verdicts.get(claim)).toBe('fail');
  });

  it('fails a passing claim when the suite actually failed', () => {
    const claim = claimOfKind('All tests pass.', 'tests');
    const verdicts = verifyAgainstTranscript([claim], {
      commands: ['npm test'],
      outcomes: [{ command: 'npm test', ok: false }],
    });
    expect(verdicts.get(claim)).toBe('fail');
  });

  it('is inconclusive when a suite ran but its outcome was not recorded', () => {
    // Ran is not the same as passed.
    const claim = claimOfKind('All tests pass.', 'tests');
    const verdicts = verifyAgainstTranscript([claim], {
      commands: ['npm test'],
    });
    expect(verdicts.get(claim)).toBe('inconclusive');
  });

  it('fails a claimed artifact that was never written', () => {
    const claim = onlyClaim('I wrote src/feature/parser.ts');
    const verdicts = verifyAgainstTranscript([claim], {
      commands: [],
      written: ['src/other.ts'],
    });
    expect(verdicts.get(claim)).toBe('fail');
  });

  it('marks a written-file claim inconclusive when no write record exists', () => {
    // Not a pass. An unprovable claim is not a verified one.
    const claim = onlyClaim('I wrote src/app.ts');
    const verdicts = verifyAgainstTranscript([claim], { commands: [] });
    expect(verdicts.get(claim)).toBe('inconclusive');
  });

  it('fails a vague completion outright', () => {
    const claim = onlyClaim('All done.');
    const verdicts = verifyAgainstTranscript([claim], transcript);
    expect(verdicts.get(claim)).toBe('fail');
  });
});

describe('independent probes', () => {
  it('probes an artifact by checking the filesystem, read-only', () => {
    const claim = onlyClaim('I wrote src/app.ts');
    const probe = probeFor(claim);
    expect(probe).toContain('test -e');
    expect(probe).toContain('src/app.ts');
    // Read-only: a probe that could change the world is not a probe.
    expect(probe).not.toMatch(/>|rm |mv |cp /);
  });

  it('has no probe for an action claim rather than inventing one', () => {
    const claim = onlyClaim('I ran the deploy script');
    expect(probeFor(claim)).toBeUndefined();
  });
});

describe('the completion gate', () => {
  it('stops a staged failed action being reported as done', () => {
    // The acceptance case: the write silently did not take effect, and the
    // transcript knows because nothing was written.
    const narration = 'I wrote src/generated/schema.ts. That is complete.';
    const report = buildReport({
      claims: extractClaims(narration),
      transcript: { commands: [], written: [] },
    });
    expect(report.complete).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
    const corrected = annotateIfUnverified(narration, report);
    expect(corrected).toContain('did not hold up');
    expect(corrected).toContain('unconfirmed, not finished');
  });

  it('lets a fully supported completion through untouched', () => {
    const narration = 'I wrote src/app.ts and all tests pass.';
    const report = buildReport({
      claims: extractClaims(narration),
      transcript: {
        commands: ['npm test'],
        written: ['src/app.ts'],
        outcomes: [{ command: 'npm test', ok: true }],
      },
    });
    expect(report.complete).toBe(true);
    expect(annotateIfUnverified(narration, report)).toBe(narration);
  });

  it('does not treat an unverifiable claim as complete', () => {
    const narration = 'I wrote src/app.ts.';
    const report = buildReport({
      claims: extractClaims(narration),
      transcript: { commands: [] },
    });
    expect(report.complete).toBe(false);
    expect(report.inconclusive).toHaveLength(1);
  });

  it('uses a probe to settle what the transcript cannot', () => {
    const narration = 'I wrote src/app.ts.';
    const report = buildReport({
      claims: extractClaims(narration),
      transcript: { commands: [] },
      probe: (claim) => ({
        claim,
        command: probeFor(claim) ?? '',
        ok: true,
      }),
    });
    expect(report.complete).toBe(true);
  });

  it('lets a failing probe override a passing transcript check', () => {
    const narration = 'I wrote src/app.ts.';
    const report = buildReport({
      claims: extractClaims(narration),
      transcript: { commands: [] },
      probe: (claim) => ({ claim, command: probeFor(claim) ?? '', ok: false }),
    });
    expect(report.complete).toBe(false);
  });

  it('does not flag a plain report as incomplete', () => {
    const report = buildReport({
      claims: extractClaims('The config sets maxTokens to 4000.'),
      transcript: { commands: [] },
    });
    expect(report.complete).toBe(true);
  });
});

describe('planning bias', () => {
  it('adds a planning beat only above the shared threshold', () => {
    expect(planningNudge('what time is it')).toBeUndefined();
    expect(planningNudge('rename a.ts to b.ts')).toBeUndefined();
    const nudge = planningNudge(
      'refactor auth.ts, update the tests, then run the suite and fix failures',
    );
    expect(nudge).toBeDefined();
    expect(nudge).toContain('direct');
    // A nudge, not a planning document.
    expect((nudge ?? '').split('\n').length).toBeLessThan(15);
  });

  it('prefers a tool capability over rebuilding its effect by hand', () => {
    expect(
      planningNudge(
        'rename a.ts to b.ts then also update imports in three files and the docs',
      ) ?? '',
    ).toContain('batch, preview, or dry-run');
  });

  it('scores a multi-step request above a single one', () => {
    expect(estimateComplexity('fix it')).toBeLessThan(
      estimateComplexity('fix a.ts, then update b.ts, then run the tests'),
    );
  });

  it('respects an explicit threshold', () => {
    const message = 'rename a.ts to b.ts then update the imports';
    expect(shouldPlan(message, DEFAULT_COMPLEXITY_THRESHOLD)).toBe(
      shouldPlan(message),
    );
    expect(shouldPlan(message, 99)).toBe(false);
  });

  it('does not plan for an empty message', () => {
    expect(shouldPlan('')).toBe(false);
    expect(estimateComplexity('')).toBe(0);
  });
});
