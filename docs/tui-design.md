# Atlas TUI — design for the presentation layer

Status: research complete, framework decided, build starting (step 1).
Scope: rendering/interaction only. Phase 4 conversation loop, memory, and the
permission system are consumed, never modified.

## 0. Decisions locked with the user

1. **TUI is the default `atlas`, conditionally.** Bare `atlas` launches the TUI
   when `process.stdout.isTTY` is true, and falls back automatically to today's
   plain `atlas chat` behavior when it is not (piped output, CI, scripted or
   non-interactive use). Rationale: if the polished UI is opt-in, most real
   usage never sees it and the work does not pay off. `atlas chat` stays
   available as an explicit escape hatch (weak SSH, plain-text preference) and
   `atlas tui` remains an explicit alias for symmetry.
2. **Animation and color are never load-bearing. Non-negotiable.** Every state
   must also be conveyed as a plain text label, not only by a color shift, so
   `NO_COLOR`, dumb terminals, screen readers, and flaky connections all get a
   fully functional Atlas that is merely less pretty. This is cheap now and
   expensive to retrofit; it is an acceptance criterion, not a nicety.
3. **Progressive reveal endorsed** over real token streaming, for the reasons in
   section 3. That narrow, separately reviewed `AssistantSession` change has
   since been built and landed — see the updated section 3. The TUI has not yet
   been switched over to consume it.

## 1. Framework decision: Ink 8 (decided, no user input needed)

Re-verified against the registry rather than trusting prior notes:

|               | Ink                                       | OpenTUI                                |
| ------------- | ----------------------------------------- | -------------------------------------- |
| latest        | `ink@8.0.0`, released/updated same day    | `@opentui/core@0.5.14` (still pre-1.0) |
| runtime       | Node `>=22` (machine has 22.22.2)         | Bun                                    |
| module format | ESM                                       | ESM                                    |
| React story   | peer `react>=19.3` (real component model) | Solid binding is the battle-tested one |

Findings point at **Ink**, so the Bun tradeoff is not put to the user. Ink is
installed: `ink@8.0.0` + `react@19.3.0`.

Two compatibility facts that make this a clean fit:

- Atlas is already `"type": "module"` with `module: NodeNext`. Ink 8 is ESM-only,
  so there is no CJS interop tax and no second build target.
- Ink 8 requires Node >= 22; the project already targets Node 22. Confirm the
  `engines` field in package.json still matches before release.

## 2. What already exists and must be reused, not reinvented

- `AssistantSession.handleInput(text) -> TurnResult`
  (`src/conversation/session.ts:269`) is the single entry point. The TUI calls
  this and nothing lower.
- `TurnResult` **already separates** `narration` from `detail`
  (`src/conversation/session.ts:43`). Requirement 3 is therefore a rendering
  concern only: the data split exists, it just needs a visual split.
- `src/cli/activity.ts` already owns a dependency-free spinner/elapsed-time
  activity line, with TTY detection and piped-output degradation. The new
  reactive indicator should extend/replace this rather than add a second
  spinner concept.
- `src/cli/repl-commands.ts` already owns slash-command parsing (`REPL_COMMANDS`,
  `parseSlashCommand`, `looksLikeCommand`, `renderHelp`). The TUI input handler
  should delegate to it so `/help`, `/facts`, `/corrections` behave identically
  in both front-ends.
- `src/conversation/narration.ts` exposes `stripExecutionLeakage`,
  `narrationForCommand`, `describeToolCall` — useful for labelling detail blocks.

## 3. Real streaming (RESOLVED — the constraint here is gone)

This section originally recorded that true token streaming was unreachable
without touching Phase 4, and that the TUI would therefore do a word-by-word
reveal of a finished `TurnResult`.

That constraint has since been lifted and resolved. `AssistantSession` and
`Conversation` now stream real tokens:

- `Conversation.send` accepts an optional `onNarrationDelta`. When present and
  the provider supports it, the call goes through `provider.streamChatTurn`
  instead of `chatCompletion`. There is still exactly **one** orchestration
  loop — streaming changes how the reply is _delivered_, not how tools are
  requested, gated, or executed.
- `AssistantSession.handleInputStreaming(text, onNarration)` returns the same
  `TurnResult` as `handleInput`. Streaming is an extra live view, never a
  different outcome.
- Providers that cannot stream fall back to a single non-streaming call and
  fire the callback once with the finished narration, so callers never branch
  on support.

### What the providers actually do (verified, not assumed)

Both providers previously implemented `streamChatCompletion` as **text-only**
and _threw_ when tools were present. Streaming tool calls had to be built:

- **OpenAI-compatible** sends one chunk per choice. Tool calls arrive as
  `delta.tool_calls` entries keyed by a stable `index`, whose `function.name`
  arrives once and whose `function.arguments` arrives as JSON _fragments_ to be
  concatenated in index order. There is no block-finished signal; a call is
  complete only at end of stream.
- **Anthropic-compatible** sends typed events instead. A tool call opens with
  `content_block_start` (`id`, `name`, empty `input`), accumulates
  `input_json_delta` fragments, and closes at `content_block_stop`.

These are handled as the genuinely different formats they are
(`src/providers/stream-events.ts`), not normalised into one assumption.

### The narration rule holds _during_ streaming

Tool-call fragments never become `text` events — assemblers hold them until a
complete, parseable call exists. That is why the permission gate still fires at
exactly the same point it always did: after a complete call exists, before it
runs.

Separately, a model can still inline JSON or a reasoning header inside its own
narration. `stripExecutionLeakage` cleans a finished reply but cannot un-show
text already sent, so `NarrationStreamGuard`
(`src/conversation/narration-guard.ts`) emits only the prefix that is provably
safe: it withholds anything inside an unterminated fence, anything from an
unbalanced `{`, and any trailing partial fence. Once it suspects a payload it
caps and holds — a live stream cannot retract, so the cost is a pause in the
preview, never a leak. The whole-text rules run over whatever it held.

**Known limitation, stated rather than hidden:** reasoning headers cannot be
withheld incrementally without retracting already-shown text, so they are
removed from the _final_ narration by `stripExecutionLeakage` but may appear
transiently in the live view.

### Still to do (deliberately a separate item)

The TUI currently calls `handleInput` and reveals progressively. Switching it to
`handleInputStreaming` is a TUI rendering change and is explicitly out of scope
for this item. The provider work, the session API, and the guard are all landed
and tested, so that switch is a small, mechanical follow-up.

## 4. State model

One state enum, shared and named to match the future GUI orb so the visual
language carries over:

`idle | thinking | executing | awaiting-confirmation | streaming`

- `idle` — ready for input.
- `thinking` — request in flight, no tool yet.
- `executing` — a shell tool is running. `describeToolCall` supplies the label.
- `awaiting-confirmation` — the dangerous-command gate is open. This state must
  be visually loud (distinct color + border) so a blocked action never looks like
  a hang; it is the safety-critical state.
- `streaming` — progressive reveal of the reply.

The TUI drives this from the existing `onTurnComplete` / confirmation callbacks
and the activity events already produced by the Phase 4 layer. If the existing
callbacks do not expose enough to distinguish `thinking` from `executing`, add a
new optional observer to `AssistantSession` — additive and default-no-op, which
does not alter conversation, memory, or permission behavior.

## 5. Module layout (new files only)

```
src/tui/
  theme.ts          color tokens, red-particle palette
  states.ts         the state enum + transitions
  components/
    Wordmark.tsx    startup splash for "Atlas"
    StatusBar.tsx   animated reactive indicator
    Narration.tsx   conversational text, main scrollback
    DetailPanel.tsx bordered/collapsible execution detail + code blocks
    Composer.tsx    input line with inline state
  App.tsx           layout: wordmark -> scrollback -> composer
  run.tsx           mounts Ink, wires AssistantSession
```

`atlas tui` becomes a new subcommand. `atlas chat` (Phase 4) stays as-is and is
the fallback for non-TTY output; the TUI should refuse to mount when
`!process.stdout.isTTY` and tell the user to use `atlas chat`.

### Wiring, without touching Phase 4

`src/cli.ts` builds the session inline in the `chat` action (`cli.ts:456-660`):
provider, `ShellTool`, `Classification`/confirmation, `FactExtractor`,
`CorrectionExtractor`, then `createAssistantSession`. The TUI needs the same
wiring. Duplicating ~200 lines invites drift, so the plan is a **pure extraction**
of that wiring into a shared builder (e.g. `src/conversation/create-runtime.ts`)
used by both `chat` and `tui`.

This extraction must be behavior-preserving: `atlas chat` output must be
byte-identical before and after. Land it as its own commit with the existing
Phase 4 tests green, so any regression is attributable.

## 6. Rendering requirements → implementation notes

1. **Reactive state indicator** — animate at ~10 fps using Ink's `useEffect`
   interval and a frame array; reuse `src/cli/activity.ts` semantics for TTY
   detection and piped-output degradation.
2. **Color/theme system** — red-particle palette in `theme.ts`, single source of
   truth shared by every component. Honor `NO_COLOR` and non-TTY by dropping to
   plain text.
3. **Narration vs. detail** — `TurnResult` gives both. Render narration in the
   main scrollback; render `detail` in a bordered panel with a distinct
   background/dimmed color and a collapse toggle. A user must be able to tell at a
   glance which is which without reading.
4. **Streaming** — progressive reveal per section 3.
5. **Polish** — `ink-gradient` for the wordmark; bordered panels; a small
   syntax-highlighting helper for fenced code inside `detail`; ease state
   transitions by cross-fading the status line rather than hard-cutting.

## 7. Test plan

Presentation must not be able to break Phase 4.

- Unit: theme resolution (incl. `NO_COLOR`), state transitions, detail
  collapsing, progressive-reveal chunking, slash-command delegation.
- Integration: render `App` against a stubbed `TurnResult` source and assert
  narration and detail land in visually distinct regions.
- Regression: the existing 442-test Phase 0-4 suite must still pass unchanged.
- Manual: run the full acceptance flow (store fact -> exit -> resume -> correct ->
  exit -> verify) and confirm the dangerous-command gate still blocks, including
  under `ATLAS_TEXT_CONFIRM_MODE=block` with durable grants.

## 8. Build order

1. Pure extraction of the session wiring into a shared builder; `atlas chat`
   unchanged; tests green.
2. `theme.ts` + `states.ts` + unit tests.
3. Static `App` with wordmark, narration, detail panel, composer.
4. Animated status indicator across all five states.
5. Progressive reveal.
6. Syntax highlighting + transition polish.
7. `atlas tui` subcommand with non-TTY fallback.
8. Full gates, manual acceptance run, README update.

## 9. Step 1 acceptance: prove the refactor, do not assert it

The `cli.ts` session-wiring extraction is a behavior-preserving refactor, which
is precisely the kind of change where a silent regression is easy to miss.

Required before step 1 is accepted: capture real `atlas chat` transcripts for
several representative turns (a plain question, a turn that executes a shell
command, a turn that trips the dangerous-command confirmation, a turn that
retrieves memory) **before** the refactor, then re-run the identical set
**after**, and present the before/after diff for inspection.

A passing test suite is not sufficient evidence here — the tests do not cover
transcript formatting. Show the diff.
