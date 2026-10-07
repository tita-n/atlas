# Reasoning filter rewrite — working plan and state

Durable state for a contract-changing rewrite. If context is compacted or
reset, resume from here.

## Goal

Replace the character-capped reasoning filter with the design the five major
harnesses converged on (vLLM/SGLang, OpenClaw, Hermes, OpenCode, qwen-code).

## Why (the evidence)

- **qwen-code**: _"its 128-char candidate cap released confirmed opening tag"_
  and let real unclosed leaks through. The currently-committed
  `LEADING_HOLD_CHARS = 128` is exactly that defect. No cap value is safe.
- **vLLM `Olmo3ReasoningBuffer`**: _starts in the reasoning state_ so a bare
  `</think>` with no opener is caught. No cap needed — the wait ends at the
  closer, not at a length threshold.
- **OpenClaw**: tag _family_ (`think, thinking, thought, reasoning, internal,
antthinking`, plus `mm:`/`antml:` prefixed), whitespace/namespace/casing
  tolerance, `isInsideCode` so tags in fenced code are literal, and a
  three-state tag classifier: `partial` (hold) / `invalid` (release) /
  confirmed. Typed lanes: `{kind:"text"} | {kind:"thinking"}`.
- **Hermes**: stateful cross-chunk buffer that _collects_ stripped reasoning
  rather than discarding it.
- **OpenCode**: reasoning as a typed event with a show/hide toggle; no text
  heuristics in the view layer.
- **Caveat**: OpenCode's issue notes models.dev has gaps, so "only known
  reasoners" is a mitigation, not a guarantee. Tag stripping still runs always.

## Target contract

```ts
type Lane = 'text' | 'reasoning';
interface Delta {
  lane: Lane;
  text: string;
}

class ReasoningFilter {
  constructor(options?: { expectsInlineReasoning?: boolean });
  push(chunk: string): Delta[];
  finish(): Delta[];
  get reasoning(): string;
  get producedAnswer(): boolean;
  get insideReasoning(): boolean;
  get sawBareCloser(): boolean;
}
function splitReasoning(text: string, options?): ReasoningSplit;
```

`push` returning `Delta[]` instead of `string` is the breaking change.

## Steps (run the FULL suite between each)

1. Rewrite `src/reasoning/reasoning-filter.ts` to the target contract.
   Verify in isolation with a scratch probe script before touching tests.
2. Migrate `Conversation.#streamTurn` to the lane API: iterate
   `reasoningFilter.push(event.text)`, only `lane === 'text'` enters `content`
   and the leakage guard. Same for `finish()`.
3. Replace the cap with a boolean. Config field `reasoningHoldChars: number`
   becomes `expectsInlineReasoning: boolean`, resolved once at startup in
   `assistant-runtime.ts` from the models.dev registry
   (`loadRegistry` -> `provider.models.find(...)` -> `reasoning === true`).
   Pass through `ConversationOptions` and to the filter.
4. Migrate `tests/reasoning/reasoning-filter.test.ts` deliberately:
   - bare-closer cases move to `expectsInlineReasoning: true`
   - `<thinking>` is now a reasoning tag (the "literal text" test is wrong)
   - `push()` call sites collect lanes
   - add: tag-family sweep, casing, whitespace, `mm:` prefix, code fence,
     no-cap long bare closer, transport-invariance across chunk sizes
5. Gates: tsc, eslint, prettier, full vitest, build.

## Traps hit so far (do not repeat)

- A `continue` in the drain loop that does not consume held text **hangs the
  suite**. Every branch must advance the index, consume, or `break`.
- Prettier reformatting can make a `str.replace` silently miss, leaving old code
  in place while new imports are added. Always assert the match applied.
- A broken intermediate build left in the tree is worse than no change.

## Outcome

Landed in `f206cc0` (rewrite) and `2a13ccc` (review fixes). The capped filter
is gone: the filter now uses typed lanes, a tag family, three-state tag
classification, fence state, and no character caps. The cap was replaced by an
`expectsInlineReasoning` boolean resolved once at startup from the models.dev
cache - cache only, so starting Atlas never depends on reaching models.dev.

Known and accepted: an unterminated tag-shaped tail holds ordinary prose until a
delimiter arrives. That is the price of catching a tag opener split across chunks
without a cap. Content is never lost and the whole-string result matches.

This document is kept only as a record of the design decisions and the traps
hit during the migration.
