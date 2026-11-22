# Sandbox integration conflict and base log

## Base selection

`B` is `c3a597b724825bc211a39e65f65a50f0e4963626` (`origin/main` at integration
start). The sandbox tip is a parentless synthetic snapshot (`e9a2a0f` is its
root), and no merge base exists. A search across the available main history
found no closer tree than `B`; however, `B` is **not** near-identical to the
synthetic snapshot: `git diff --stat B e9a2a0f` reports 35 paths, 11,214
insertions, and 88 deletions. This reflects product/docs files that differ
between the recovered snapshot and current main, so grafting `e9a2a0f` onto B
would make Git treat the entire tree delta as sandbox work and risk undoing main.

Method: apply the sandbox net patch `e9a2a0f..origin/sandbox-wip` onto `B` with
three-way application, then reconcile conflicts. This preserves main's current
tree and applies only the sandbox branch's net changes; it does not rewrite or
replace either source branch. No `git replace --graft` was used.

## Conflict records

The merge-application index stages were read as `:1` (synthetic base), `:2`
(main), and `:3` (sandbox). `git log B..origin/main -- <file>` is empty for each
file because B is the main tip; the sandbox file history is listed below.

### `src/shell/shell-tool.ts`

- Main intent: preserve the existing shell UX, confirmation outputs, dry-run,
  grants, and result formatting; the main-side version had removed the
  unconditional hard-floor check and was coupled to `ShellSession`.
- Sandbox intent: execute through `ExecutionSession`, refuse unsafe commands
  when the backend is `refusing`, consult the floor regardless of grants, and
  record actual backend/profile/gate path on audit rows.
- Sandbox file commits: `022bdf7`, `2c538c9`.
- Decisions: kept the execution-environment session and sandbox refusal/audit
  paths; retained preview, grant and output handling; moved hard-floor
  evaluation before classifier tier/grant decisions and before preview, so no
  early path bypasses it. Classifier blocks and floor denials retain distinct
  audit paths. Main's removal of the floor was not carried forward because it
  contradicts the explicit invariant. Also applied the sandbox `ShellSession`
  argv support so bwrap is spawned with its exact argv and `shell: false`.
  Recoverable safety-config writes are not permanently blocked: a floor hit
  forces the shared confirmation flow even when the classifier/autonomy would
  otherwise skip asking; catastrophic tier-1 commands remain denied.

### `src/conversation/assistant-runtime.ts`

- Main intent: retain runtime/session lifecycle, conversation memory and
  provider behavior; its side had replaced the sandbox session with a local
  `ShellSession` and directly constructed a `ConfirmationFlow`.
- Sandbox intent: all runtime construction resolves an `ExecutionEnvironment`,
  invokes `createGate`, reports protection before turns, and scopes file tools.
- Sandbox file commits: `022bdf7`, `09b6bb9`.
- Decisions: kept `createAssistantRuntime` as the only session builder; retained
  `createGate`, environment resolution, protection callback, file tools,
  trusted-profile selection, and status/audit wiring. Main's direct gate and
  host-shell path were rejected because they bypass the required builder and
  execution boundary. Applied the sandbox `CreateSessionOptions.fileTools`
  router and `FileTools` implementation where main's tree lacked that API.
  Existing runtime provider/memory lifecycle remains in place.

### `src/cli.ts`

- Main intent: retain the CLI command surface, provider/model setup, and plain
  and TUI front ends; its side also contained a second legacy `runChat` path
  that constructed its own conversation and shell tool.
- Sandbox intent: every interactive front end calls the shared runtime; retain
  protection status, trust/full-access controls, guarded legacy-mode handling,
  bundled catalogue and key validation.
- Sandbox file commits: `7dc59c3`, `48d410d`, `022bdf7`, `09b6bb9`.
- Decisions: retained main's command surface and reusable front ends while
  routing interactive sessions through `createAssistantRuntime`; retained
  sandbox `status`, `trust`, `full-access`, models, and configuration flows.
  Did not restore a direct `runChat` session constructor or raw-chat bypass.
  Provider/model catalogue and memory commands are preserved in the selected
  CLI tree. Any command that does not create an assistant session remains a
  separate administrative command, not an alternate model execution path.

### `src/tui/run.tsx`

- Main intent: retain Ink TUI, config/key setup, bridge, and render lifecycle.
- Sandbox intent: report protection in the status bar before first prompt and
  route session construction through the shared runtime; validate provider keys
  without writing config before a verdict.
- Sandbox file commits: `7dc59c3`, `09b6bb9`.
- Decisions: kept the TUI render/lifecycle and runtime builder; wired
  `onProtectionChange` to `TuiBridge.setProtection` and forwarded it; retained
  `validateApiKey` and the protection status bar. The callback is no longer
  merely a truthiness gate and no separate execution session is created here.

## Evidence caveat

This is a decision log, not proof of invariant satisfaction. The build, tests,
architectural scan, bypass audit, matrix runs, and front-end exercises must be
completed before this branch is considered verified.
