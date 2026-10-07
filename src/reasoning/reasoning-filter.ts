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
 *
 * The classification is a decision procedure over prefixes of a valid tag, not a
 * guess: `invalid` means no completion of the text seen so far can ever be a
 * tag, so releasing it is final; `partial` means one can, so the text is held
 * and re-decided with the next chunk. That is what makes the result identical
 * for every chunk size, at every offset.
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

function alternation(parts: readonly string[]): string {
  return [...new Set(parts)].sort((a, b) => b.length - a.length).join('|');
}

/** Every tag body, namespace included: `think`, `mm:think`, `antml:thinking`. */
const TAG_BODIES: readonly string[] = TAG_PREFIXES.flatMap((prefix) =>
  REASONING_TAG_NAMES.map((name) => prefix + name),
);

/** Every prefix of `text`, shortest first, including `text` itself. */
function everyPrefix(text: string): readonly string[] {
  const prefixes: string[] = [];
  for (let at = 1; at <= text.length; at += 1) prefixes.push(text.slice(0, at));
  return prefixes;
}

/**
 * Every prefix of every tag body.
 *
 * A held tail is a possible tag exactly when it is a prefix of a real tag, so
 * this list is the whole definition of "partial" - including `<`, `</`, `<mm:`
 * and every name prefix, which no hand-written list of literal spellings would
 * cover.
 */
const TAG_BODY_PREFIXES: readonly string[] = [
  '',
  ...TAG_BODIES.flatMap(everyPrefix),
];

/**
 * A complete tag, tolerating whitespace, a prefix, casing, and attributes.
 *
 * `(?!-)` keeps `<internal-link>` and `<thinker>` out: an HTML tag name
 * continues with a hyphen, a reasoning tag does not.
 */
const TAG_RE = new RegExp(
  `<\\s*(/?)\\s*(?:${alternation(TAG_BODIES)})\\b(?!-)(?:\\s[^>]*)?>`,
  'iy',
);

/**
 * A tag that could still arrive.
 *
 * Either the tail stops part-way through a tag name, or it has a complete name
 * followed by the start of what could be an attribute list. Both spellings have
 * to be covered: `<thi` and `<think ` are the same failure.
 */
const PARTIAL_TAG_RE = new RegExp(
  `<\\s*(?:/\\s*)?(?:${alternation(TAG_BODY_PREFIXES)})$` +
    `|<\\s*(?:/\\s*)?(?:${alternation(TAG_BODIES)})\\s[^<>]*$`,
  'iy',
);

/**
 * An opener with no closing `>` yet.
 *
 * Deliberately permissive about what follows the `<`: a lone `<` is just as
 * capable of becoming a tag as `<think ` is, and releasing it is how a whole
 * reasoning block leaks one character at a time.
 */
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

type FenceVerdict =
  | { readonly kind: 'open'; readonly length: number }
  | { readonly kind: 'partial' }
  | { readonly kind: 'none' };

/** The one verdict meaning "hold this tail until more arrives". */
const HELD: TagVerdict = { kind: 'partial' };

/**
 * Classifies what sits at `at`.
 *
 * `partial` means the remainder could still grow into a real tag, so it is held
 * rather than shown: a half-arrived `<th` must never reach the screen, and
 * neither must the reasoning behind it. `invalid` is final by construction - no
 * longer text can complete a tag that does not start here - which is what lets
 * the same bytes be emitted one chunk at a time or all at once.
 *
 * The two module-level regexes carry `lastIndex` between calls. That is safe
 * because draining is synchronous and never interleaves.
 */
function classifyTagAt(text: string, at: number): TagVerdict {
  TAG_RE.lastIndex = at;
  const match = TAG_RE.exec(text);
  if (match !== null) {
    return {
      kind: 'confirmed',
      close: match[1] === '/',
      length: match[0].length,
    };
  }
  // Any unterminated tag opener is held, however partial. This covers a lone
  // `<`, `<think `, and `<mm:think` alike: releasing any of them would let the
  // reasoning behind it stream out as narration.
  PARTIAL_TAG_RE.lastIndex = at;
  if (PARTIAL_TAG_RE.test(text)) return { kind: 'partial' };
  PARTIAL_TAG_RE.lastIndex = at;
  if (PARTIAL_TAG_RE.test(text)) return { kind: 'partial' };
  return { kind: 'invalid' };
}

/** How many backticks run from `from`. */
function backtickRun(text: string, from: number): number {
  let end = from;
  while (text[end] === '`') end += 1;
  return end - from;
}

/**
 * Classifies the fence at `at`.
 *
 * `partial` is only returned when the run of backticks touches the end of the
 * buffer, because that is the only way it can still grow into a fence. A short
 * complete run is inline code, not a fence.
 */
function classifyFenceAt(text: string, at: number): FenceVerdict {
  const run = backtickRun(text, at);
  if (run >= FENCE.length) return { kind: 'open', length: run };
  if (run === 0 || at + run < text.length) return { kind: 'none' };
  return { kind: 'partial' };
}

/** Index just past a closing fence at least as long as `openLength`, else -1. */
function findFenceClose(
  text: string,
  from: number,
  openLength: number,
): number {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] !== '`') continue;
    const run = backtickRun(text, at);
    if (run >= openLength) return at + run;
    at += run - 1;
  }
  return -1;
}

/**
 * How much of a fenced block can be emitted now.
 *
 * Content inside a fence is literal, so emitting it early is safe, but a
 * trailing run of backticks may still grow into the closing fence and start a
 * new block, so it is held like a partial tag.
 */
function literalEmitEnd(text: string, from: number): number {
  let end = text.length;
  while (end > from && text[end - 1] === '`') end -= 1;
  return end;
}

export interface FilterOptions {
  /**
   * Whether this model is known to emit reasoning inline.
   *
   * True starts in the reasoning state and holds until the tag can be
   * classified, which is what catches a bare closing tag. False applies no
   * opening hold at all, so ordinary replies stream immediately; complete and
   * unterminated blocks are still stripped, because neither needs a hold. Text
   * that could still grow into a tag is held either way, so prose containing
   * something like `a < thinking` is emitted only once it can be decided - the
   * cost of never releasing a half-formed tag.
   */
  readonly expectsInlineReasoning?: boolean;
}

export class ReasoningFilter {
  #held = '';
  #reasoning = '';
  #inside: boolean;
  #insideFence = false;
  #fenceLength = 0;
  /** Nested openers inside reasoning; only a closer at depth 0 ends the block. */
  #depth = 0;
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
      if (this.#insideFence) {
        // A fenced block is state, not a buffer scan: the closing fence can
        // arrive in a later chunk, and everything between is literal.
        const close = findFenceClose(this.#held, index, this.#fenceLength);
        if (close === -1) {
          const emitTo = literalEmitEnd(this.#held, index);
          out += this.#held.slice(index, emitTo);
          index = emitTo;
          break;
        }
        out += this.#held.slice(index, close);
        index = close;
        this.#insideFence = false;
        this.#fenceLength = 0;
        continue;
      }

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
          // A nested opener. Real reasoners do not emit one, but treating it
          // as reasoning text would let the inner closer end the outer block
          // and put the rest of the reasoning on the answer lane.
          this.#depth += 1;
        } else if (this.#depth > 0) {
          this.#depth -= 1;
        } else {
          // Everything before the closer has already been claimed above.
          this.#inside = false;
          this.#depth = 0;
          // In reasoner mode the opening state is assumed, so the first closer
          // is a bare closer: no opener was ever seen.
          if (!this.#sawOpener) this.#sawBareCloser = true;
        }
        this.#held = this.#held.slice(index + verdict.length);
        index = 0;
        continue;
      }

      // Outside reasoning: a fenced block makes any tag inside it literal.
      const fence = classifyFenceAt(this.#held, index);
      if (fence.kind === 'open') {
        out += this.#held.slice(index, index + fence.length);
        index += fence.length;
        this.#insideFence = true;
        this.#fenceLength = fence.length;
        continue;
      }
      const verdict =
        fence.kind === 'none' ? classifyTagAt(this.#held, index) : HELD;
      if (verdict.kind === 'invalid') {
        out += this.#held[index] ?? '';
        index += 1;
        continue;
      }
      if (verdict.kind === 'partial') {
        // A tag or a fence that could still arrive. Chars before this point
        // were already emitted individually; trim the buffer so the next chunk
        // cannot re-emit them.
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
        this.#depth = 0;
      }
      this.#held = this.#held.slice(index + verdict.length);
      index = 0;
    }

    // Everything scanned past has been emitted; drop it from the buffer so the
    // next chunk cannot re-emit it.
    this.#held = this.#held.slice(index);

    if (final) {
      // Nothing more can arrive, so nothing is still undecided: whatever is
      // left belongs to the lane the stream is already in.
      if (this.#inside) this.#reasoning += this.#held;
      else out += this.#held;
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
