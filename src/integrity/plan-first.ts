/**
 * A lightweight bias toward the direct path.
 *
 * The failure this addresses is well documented: an agent "finds one plausible
 * next action, follows it, and then spends the rest of the run trying to make
 * that first choice work". Search and planning before acting measurably beat
 * one-shot generation - but a heavyweight planner for a one-line question is
 * just overhead, and research on agentic search is explicit that a bad first
 * plan is worse than none because recovery gets expensive.
 *
 * So this is a prompt-level nudge, not a second orchestration phase: state the
 * approach, and ask once whether a direct route exists - including preferring a
 * tool's own batch or preview capability over reconstructing its effect by hand.
 */

/**
 * Shared complexity threshold.
 *
 * One knob, used by both this and the fidelity check, so "when do we add
 * ceremony" is a single decision rather than two that drift apart.
 */
export const DEFAULT_COMPLEXITY_THRESHOLD = 3;

/**
 * Connectives that reliably mark a step in a request.
 *
 * "then", "next", "finally" and "after that" are doing the same job whether
 * or not the message names a file. The rest are ordinary English far more
 * often than they are step markers, so they only count alongside a real path.
 */
const STEP_CONNECTIVES = /\b(?:then|and then|after that|next|finally)\b/gi;

/**
 * Connectives that mark a step only when the message also names something
 * concrete. "First of all, is there a next step? Also, should I bother?" is a
 * question, and a nudge aimed at it is attention the model does not need.
 */
const SOFT_CONNECTIVES = /\b(?:also|first|second|third|once)\b/gi;

/**
 * A crude but stable signal of whether a task is non-trivial.
 *
 * Counts distinct commands the message implies plus files it names. Cheap, has
 * no side effects, and errs toward not planning rather than over-planning.
 */
export function estimateComplexity(message: string): number {
  const text = message.trim();
  if (text === '') return 0;

  let score = 0;

  // Named files or paths. The extension is two characters or more so that
  // abbreviations like "e.g." do not read as filenames.
  const paths = text.match(/[\w-]+\/[\w./-]+|\b[\w-]+\.[a-z]{2,6}\b/gu);
  const namedPaths = new Set(paths ?? []);
  score += Math.min(3, namedPaths.size);

  score += text.match(STEP_CONNECTIVES)?.length ?? 0;
  if (namedPaths.size > 0) {
    score += text.match(SOFT_CONNECTIVES)?.length ?? 0;
  }

  // A plural verb plus a conjunction usually means a batch of work.
  if (/\b\w+(?:s|es)\b.*\band\b/iu.test(text)) score += 1;

  return score;
}

/** Whether this message is worth a planning beat. */
export function shouldPlan(
  message: string,
  threshold: number = DEFAULT_COMPLEXITY_THRESHOLD,
): boolean {
  return estimateComplexity(message) >= threshold;
}

/**
 * The planning instruction, or undefined when the task is trivial.
 *
 * Deliberately short. The goal is to make the model consider the direct route
 * once, not to make it produce a plan document before saying hello.
 */
export function planningNudge(
  message: string,
  threshold: number = DEFAULT_COMPLEXITY_THRESHOLD,
): string | undefined {
  if (!shouldPlan(message, threshold)) return undefined;
  return [
    'Before acting, spend one line on your approach:',
    '',
    '- state the shortest correct route in a sentence;',
    '- check whether a tool already has a batch, preview, or dry-run mode that',
    '  would get there directly, rather than reproducing its effect by hand;',
    '- if a direct route exists, take it; if not, say what rules it out.',
    '',
    'Keep this to a sentence or two. Do not write a plan document, and do not',
    'restate the request.',
  ].join('\n');
}
