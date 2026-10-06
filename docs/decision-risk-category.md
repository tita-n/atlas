# Decision: additive `category` on `RiskAssessment`

**Status:** approved, 2026-10-06. Not yet implemented — this records the decision
and its guard rails so the next session can proceed without re-litigating it.

## What was decided

The permission classifier gains an **optional `category` field on the
`RiskAssessment` it already returns**. This is an exception to the standing
"do not modify the permission-gate decision logic" rule, and it is the only
exception granted for this phase.

## Why the exception is legitimate

The boundary was written to protect **what the gate judges dangerous and at what
tier**. A category label alters neither: it names what was _already_ flagged and
changes no decision. The boundary was phrased loosely enough that additive output
metadata appeared to breach it; it does not breach its intent.

## Why Scoped approval needs it

`scoped-approval` asks "is this within the scope the user approved?" Without a
category there is nothing to scope against, so every command is uncategorised
and the fail-closed rule asks about everything. Scoped approval then behaves
exactly like `confirm-everything`, making three advertised levels behave as two.

Fail-closed-but-useless was chosen over fail-open-and-dangerous, deliberately.
This decision makes the useful behaviour reachable without weakening that choice.

## Non-negotiable guard rails

A miscategorised rule does **not** fail loudly: scoped approval's whole purpose is
to skip prompts for dangerous-but-fixable work, so a wrong category would
silently wave through something that should have been asked about. The hard floor
covers only catastrophic classes and does **not** mitigate this. Therefore:

1. **Closed vocabulary.** No free text. The only permitted values are:
   `filesystem`, `network`, `services`, `packages`, `processes`, `vcs`,
   `atlas-self`.
2. **Uncategorised always asks.** An assessment with no category is treated as
   out of scope. This is already implemented in `shouldAsk` and becomes the
   load-bearing default, not a fallback.
3. **Scope matches on category only.** Never on rule id, command text, or any
   other property. Otherwise the scope becomes a second, coarser allowlist and
   the feature quietly grows a per-command escape hatch nobody designed.
4. **`atlas-self` is additionally hard-floored.** A miscategorised attempt to edit
   Atlas's own gating must not become skippable by being placed in an approved
   scope.

With these, the worst achievable outcome from a classification mistake is asking
when it did not need to — the same safe direction as the bug fixed in this phase.

## Implementation notes

- `RiskAssessment.category?: Category` — optional, absent by default, so existing
  rules and tests keep compiling and keep their current behaviour.
- Populate conservatively. `hard-deny-*` rules are irrelevant here: tier 1 is
  denied outright and never reaches the autonomy check.
- The ~43 `ask-*` rules are the ones that need labels. Any rule not confidently
  classifiable is left uncategorised, which means it keeps asking.
- Wire `category` into the existing `shouldAsk` call site. No change to the
  ordering: the hard floor is still evaluated first and cannot be influenced by
  level or scope.

## Test requirement this phase earned

The bug fixed in this phase — `#hardFloor` and `#autonomy` declared and read but
never assigned — passed 41 unit tests because every test exercised the pure
functions (`shouldAsk`, `hardFloorVerdict`) rather than the live wiring.

**Any test for the category change must drive a real `ShellTool` through a real
`ShellSession` and assert on the audit row and on whether a prompt happened.**
A test that only calls `shouldAsk` is not evidence the gate is wired.
