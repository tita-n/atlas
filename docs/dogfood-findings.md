# Dogfood findings (recovered from an agent transcript)

The adversarial QA agent ran out of time before writing its report. These are
its findings, extracted from its session transcript and then **independently
verified by hand** where verification was possible. Verification status is
stated per item — do not trust the unverified ones.

## Verified and FIXED

### CRITICAL — a stale lock permanently bricked the CLI

`atlas.lock` survived `kill -9`, a crash, or a closed terminal, and every later
launch refused to start with "Another Atlas session already has ... open". The
lock file even recorded the owning PID, but nothing ever checked whether that
process was still alive. There was no `--force` and no stale-PID detection.

**Reproduced by hand:** held a session open, `kill -9`ed it, then confirmed two
consecutive launches were both permanently blocked.

**Fixed** in `src/conversation/assistant-runtime.ts`:

- `acquireLock()` reads the recorded PID and reclaims the lock when that process
  is gone (`process.kill(pid, 0)`; `EPERM` counts as alive).
- The conflict message now names the holding PID.
- The lock file is created `0600`, matching the database beside it.
- **A second bug surfaced while fixing it:** release was fire-and-forget
  (`void handle.close().then(...)`), so on a _clean_ exit the removal raced
  process exit and the lock survived anyway — defeating the entire guard. Release
  is now awaited during teardown.

Verified after the fix: clean exit removes the lock; a live session still blocks
a second one (reporting the pid); a dead session's lock self-heals.

## Investigated, NOT reproduced — treat with suspicion

### HIGH (claimed) — TUI cannot approve a dangerous command with one Enter

The agent reported the confirmation needed two Enter presses.

**Did not reproduce.** Driving the real TUI in a pty with a mock provider, a
single Enter after typing the phrase resolved the gate and ran the command. The
audit log records `decision: 'asked-approved'`, `exit_code: 0`.

The agent was probably grepping for `Exit code: 0` in the terminal output — but
the detail panel is collapsed by default, so that text is never on screen. That
is a plausible explanation for its false positive, and the audit log is the
authoritative record.

A real robustness bug was fixed anyway: `submit()` read render-scoped `input`,
so if keystrokes and Enter arrived in one batch the gate could be answered with
stale text. Input is now mirrored in a ref updated synchronously.

### MEDIUM (claimed) — `TERM=dumb` makes the TUI ignore all input

Plausible and untested by me. If real, the mitigation is the same stale-lock
recovery now in place: an unkillable session still self-heals on next launch.

## Reported by the agent, not yet triaged

Ordered roughly by how much damage they could do.

1. **HIGH — non-alternating roles persisted on interrupt.** An interrupted turn
   can leave `user, user, assistant, assistant` in the transcript. Real
   OpenAI/Anthropic endpoints reject that, which would break a user's
   conversation until they delete it. Worth verifying first; it is a data
   integrity problem, not cosmetic.
2. **HIGH — `atlas chat` silently discards input after the first line.** With
   piped stdin (`atlas chat < file`) and with multi-line pastes, only the first
   line is processed; the rest are dropped without a message. Also: a line typed
   while a turn is running is discarded silently. The agent reports the same
   case reproduced in a real TTY with a pasted three-line prompt.
3. **MEDIUM — over-eager `stripExecutionLeakage`.** The JSON stripper removes any
   object with keys like `name`/`input`/`arguments`, so a legitimate reply
   containing `{"name": "atlas"}` has that text silently deleted from the user's
   view. The opposite case also holds: an unbalanced brace leaves raw JSON in
   narration. Not a safety leak, but it silently edits what the user is told.
4. **MEDIUM — `/corrections forget 1 junk` deletes correction #1.**
   `parseInt` stops at the first non-digit, so trailing junk is ignored and a
   real correction is removed while the user thought they typed something
   invalid.
5. **MEDIUM — TUI paste needs an extra Enter.** Ink ignores the trailing newline
   of a paste; the text arrives with embedded newlines and the paste's own Enter
   does nothing.

## Not bugs (negative evidence worth keeping)

- `ATLAS_TEXT_CONFIRM_MODE=block` is **not** bypassed by a pre-seeded durable
  grant. Confirmed directly against the audit log.
- A hallucinated tool name is refused rather than executed.
- Provider misbehaviour (HTTP 200 with an error body, garbage non-JSON, empty
  content, `tool_calls` with empty content) is handled with a visible error
  rather than a silent empty turn.

---

# TUI v2 QA pass (recovered from an agent transcript)

A quality agent over the interaction-model rebuild timed out before writing its
report. Findings below were extracted from its transcript; the two serious ones
were then **reproduced and fixed by hand**, and the fixes were re-verified.

## CRITICAL — Enter approved a dangerous command. FIXED.

With the two-option confirmation modal open, pressing Enter ran the command.

Root cause: the highlight index started at `0`, which is the _approving_
option. A comment in the code claimed Enter "defaults to cancel", so the bug
was documented as safe while behaving the opposite way.

Fixed: the highlight now starts on the non-approving option, so Enter can
refuse but never approve. Approval requires a deliberate press of its own key.

Re-verified through the real TUI, confirmed in the audit log:

    key=Enter -> asked-denied   (no execution)
    key=y     -> asked-approved, exit 0
    key=n     -> asked-denied

## HIGH — the prompt queue dropped and reordered prompts. FIXED.

A separate cursor indexed the same array that was simultaneously being sliced,
so the two desynchronized: prompts were silently dropped, ran out of order, and
could leave the queue permanently stuck.

Fixed: the queue array is the only source of ordering; there is no cursor.

Re-verified — three prompts typed during a turn all ran, in order:

    first question / second question / third question

## Verified correct by the agent (no action)

- `/model` genuinely switches the model: the provider received the newly
  selected model on the next request.
- `/init` never leaks the API key, on the success path or the failure path —
  zero occurrences of the typed key anywhere in the captured terminal output.
- `NO_COLOR` emits zero SGR colour codes.

## Harness flaw the agent caught in my own tooling

The pty driver hardcoded `TERM=xterm-256color`, so `TERM=dumb` had never
actually been exercised. The driver now honours `FORCE_TERM`.

Re-tested with `TERM=dumb`: zero SGR codes, the confirmation modal still
renders, the command is still shown, and the decision still lands correctly.
