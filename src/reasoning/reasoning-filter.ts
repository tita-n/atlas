/**
 * Separating model reasoning from the answer, as a first-class lane.
 *
 * This follows the design every mature harness converged on rather than
 * inventing a fourth one:
 *
 *   - Reasoning is its own typed lane, never merged into the answer and then
 *     split back out.
 *   - A family of tag names is matched - think, thinking, thought, reasoning,
 *     internal, antthinking, and the mm:/antml: prefixed variants - tolerating
 *     whitespace, a namespace prefix, and any casing. Matching one literal is
 *     how the original bug survives as <THINK>.
 *   - A tag is classified three ways: partial (hold for more input), confirmed,
 *     or invalid (release as ordinary text). A binary hold/release cannot
 *     express "this might still become a tag".
 *   - Tags inside a fenced code block are literal text, so a code sample
 *     containing a think tag survives.
 *   - There are no character caps. A cap releases reasoning it should have
 *     held, which is precisely how a monologue reaches the user.
 *
 * A model known to emit reasoning inline is handled by starting in the reasoning
 * state and holding until the tag can be classified. That catches a bare closing
 * tag with no opener, and needs no cap because the wait ends at the closer.
 */

export const REASONING_TAG_NAMES: readonly string[] = [
  'think',
  'thinking',
  'thought',
  'reasoning',
  'internal',
  'antthinking',
];

const TAG_PREFIXES: readonly string[] = ['', 'mm:', 'antml:'];

/** A complete tag, tolerating whitespace, a prefix, casing, and attributes. */
const TAG_RE = new RegExp(
  `<\\s*(/?)\\s*(?:(?:antml|mm):)?(?:${REASONING_TAG_NAMES.join('|')})\\b[^>]*>`,
  'i',
);

/** Literal spellings, for recognising a tag that has only partly arrived. */
const CANDIDATE_TAGS: readonly string[] = TAG_PREFIXES.flatMap((prefix) =>
  REASONING_TAG_NAMES.flatMap((name) => [
    `<${prefix}${name}>`,
    `</${prefix}${name}>`,
  ]),
);

const FENCE = '```';

export type Lane = 'text' | 'reasoning';

export interface Delta {
  readonly lane: Lane;
  readonly text: string;
}

type TagVerdict =
  | {
      readonly kind: 'confirmed';
      readonly close: boolean;
      readonly length: number;
    }
  | { readonly kind: 'partial' }
  | { readonly kind: 'invalid' };

/**
 * Classifies what sits at `at`.
 *
 * `partial` means the remainder could still grow into a real tag, so it is held
 * rather than shown: a half-arrived `<th` must never reach the screen, and
 * neither must the reasoning behind it.
 */
function classifyTagAt(text: string, at: number): TagVerdict {
  const match = TAG_RE.exec(text.slice(at));
  if (match !== null && match.index === 0) {
    return {
      kind: 'confirmed',
      close: match[1] === '/',
      length: match[0].length,
    };
  }
  const tail = text.slice(at).toLowerCase();
  for (const candidate of CANDIDATE_TAGS) {
    if (
      candidate.length > tail.length &&
      candidate.toLowerCase().startsWith(tail)
    ) {
      return { kind: 'partial' };
    }
  }
  return { kind: 'invalid' };
}

export interface FilterOptions {
  /**
   * Whether this model is known to emit reasoning inline.
   *
   * True starts in the reasoning state and holds until the tag can be
   * classified, which is what catches a bare closing tag. False applies no
   * opening hold at all, so ordinary replies stream immediately; complete and
   * unterminated blocks are still stripped, because neither needs a hold.
   */
  readonly expectsInlineReasoning?: boolean;
}

export class ReasoningFilter {
  #held = '';
  #reasoning = '';
  #inside: boolean;
  #sawAnswer = false;
  #sawBareCloser = false;
  /** Whether an opening reasoning tag was ever actually observed. */
  #sawOpener = false;
  readonly #expectsReasoning: boolean;

  public constructor(options: FilterOptions = {}) {
    this.#expectsReasoning = options.expectsInlineReasoning === true;
    this.#inside = this.#expectsReasoning;
  }

  public get reasoning(): string {
    return this.#reasoning;
  }

  public get producedAnswer(): boolean {
    return this.#sawAnswer;
  }

  public get insideReasoning(): boolean {
    return this.#inside;
  }

  public get sawBareCloser(): boolean {
    return this.#sawBareCloser;
  }

  public push(chunk: string): Delta[] {
    if (chunk === '') return [];
    this.#held += chunk;
    return this.#drain(false);
  }

  /**
   * Ends the stream.
   *
   * A stream that ended inside reasoning yields no answer at all: there was
   * none, and releasing the fragment would present an incomplete generation as
   * a reply.
   */
  public finish(): Delta[] {
    return this.#drain(true);
  }

  #drain(final: boolean): Delta[] {
    const deltas: Delta[] = [];
    let out = '';

    let index = 0;
    // Every branch either advances `index`, consumes held text, or breaks, so
    // this cannot loop forever.
    while (index < this.#held.length) {
      if (this.#inside) {
        const verdict = classifyTagAt(this.#held, index);
        if (verdict.kind === 'invalid') {
          // Reasoning text that merely looks like a tag: claim it now, so it
          // cannot be dropped when the buffer is trimmed.
          this.#reasoning += this.#held[index] ?? '';
          index += 1;
          continue;
        }
        if (verdict.kind === 'partial') {
          // The remaining tail is still a possible tag, so it is held rather
          // than claimed.
          if (!final) break;
          this.#reasoning += this.#held;
          this.#held = '';
          index = 0;
          continue;
        }
        if (!verdict.close) {
          // Nested openers are not a shape real reasoners emit; treat as text.
          index += 1;
          continue;
        }
        // Everything before the closer has already been claimed above.
        this.#held = this.#held.slice(index + verdict.length);
        // In reasoner mode the opening state is assumed, so the first closer is
        // a bare closer: no opener was ever seen.
        if (!this.#sawOpener) this.#sawBareCloser = true;
        this.#inside = false;
        index = 0;
        continue;
      }

      // Outside reasoning: a fenced block makes any tag inside it literal.
      if (this.#held.startsWith(FENCE, index)) {
        const end = this.#held.indexOf(FENCE, index + FENCE.length);
        if (end === -1) {
          out += this.#held.slice(index);
          index = this.#held.length;
          break;
        }
        out += this.#held.slice(index, end + FENCE.length);
        index = end + FENCE.length;
        continue;
      }

      const verdict = classifyTagAt(this.#held, index);
      if (verdict.kind === 'invalid') {
        out += this.#held[index] ?? '';
        index += 1;
        continue;
      }
      if (verdict.kind === 'partial') {
        // Chars before this point were already emitted individually. Trim the
        // buffer so the next chunk cannot re-emit them.
        this.#held = this.#held.slice(index);
        index = 0;
        if (!final) break;
        out += this.#held;
        this.#held = '';
        continue;
      }
      if (verdict.close) {
        // A closer with no opener: everything before it was reasoning.
        this.#sawBareCloser = true;
        this.#sawAnswer = false;
      } else {
        this.#inside = true;
        this.#sawOpener = true;
      }
      this.#held = this.#held.slice(index + verdict.length);
      index = 0;
    }

    // Everything scanned past has been emitted; drop it from the buffer so the
    // next chunk cannot re-emit it.
    this.#held = this.#held.slice(index);

    if (final && !this.#inside) {
      // Anything left over at end of stream is ordinary answer text.
      out += this.#held;
      this.#held = '';
    }
    if (out !== '') {
      if (out.trim() !== '') this.#sawAnswer = true;
      deltas.push({ lane: 'text', text: out });
    }
    return deltas;
  }
}

export interface ReasoningSplit {
  readonly narration: string;
  readonly reasoning: string;
  readonly insideReasoning: boolean;
  readonly sawBareCloser: boolean;
}

export function splitReasoning(
  text: string,
  options: FilterOptions = {},
): ReasoningSplit {
  const filter = new ReasoningFilter(options);
  let narration = '';
  for (const delta of [...filter.push(text), ...filter.finish()]) {
    if (delta.lane === 'text') narration += delta.text;
  }
  return {
    narration,
    reasoning: filter.reasoning,
    insideReasoning: filter.insideReasoning,
    sawBareCloser: filter.sawBareCloser,
  };
}
