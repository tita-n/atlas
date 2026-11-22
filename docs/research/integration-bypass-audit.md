# Main-commit bypass audit (merged source tree)

Audit scope: `src/**/*.ts` and `src/**/*.tsx`. The grep covered process APIs,
direct filesystem mutation APIs, dynamic module loading, `eval`/`Function`/VM
execution, and network APIs. This is a static reachability audit; it does not
prove runtime behavior beyond the cited call paths.

## Process creation

| Module | Process surface | Model-driven input? | Disposition |
| --- | --- | --- | --- |
| `src/execution/bwrap/bwrap-environment.ts` | `spawn` bwrap with generated argv | Indirectly: model shell commands are submitted to the sandbox session | Required execution boundary. Uses argv arrays, `shell:false`; isolation is checked before every shell start/restart. |
| `src/shell/shell-session.ts` | `spawn` the configured argv; command text is sent over the persistent shell protocol | Yes, through `ShellTool` | Single execution broker. In normal mode argv is bwrap; host shell is reachable only through explicit full-access ceremony. |
| `src/permissions/sudoers-setup.ts` | `spawn` the configured sudoers installation command | No; explicit operator setup confirmation | Scoped operator administration, not a model tool. |
| `src/selfmod/cli.ts` | `spawnSync('git', argv)` for repository state | No direct model tool; explicit CLI command and proposal file | Fixed executable with argument array; remains an operator-facing self-modification flow. |
| `src/selfmod/runner.ts` | `execFile` for validation/build steps | No direct model tool; CLI proposal is human supplied | Runs only fixed health-step argv in a scratch copy; live apply is gated by explicit approval and path containment. |
| `src/voice/audio-capture.ts` | `spawn` configured audio backend | No; backend is local voice configuration | Hardware/audio capture only; not invoked from model command text. |
| `src/voice/speaker-verification.ts` | `spawn` configured speaker verifier | No; backend/configuration is operator-controlled | Voice identity subsystem; not an assistant shell execution path. |
| `src/voice/model-manager.ts` | Dynamic `execFile('tar', ['xjf', partial, '-C', target])` | No; only explicit voice model setup | Fixed executable/argv, downloads are manifest-selected, extraction stays in managed model directory. |

## Direct filesystem mutation APIs

| Module | Mutation purpose and reachability |
| --- | --- |
| `src/config/config.ts` | Atomic user config save; CLI/TUI user settings, not model-invoked. |
| `src/conversation/assistant-runtime.ts` | Exclusive runtime lock create/remove; lifecycle only. |
| `src/conversation/personality.ts` | Initialize user personality at a fixed user config path; no model tool. |
| `src/conversation/session.ts` | Write one-time notice marker; its `FileTools` operations are the model-facing path and are scoped by the shared protected-target policy. |
| `src/execution/full-access.ts` | Operator grant/evidence writes and revocation; ceremony-gated, no model tool. |
| `src/execution/trust.ts` | Operator trust records/evidence; explicit trust CLI, no model tool. |
| `src/memory/database.ts` | Create configured database parent directory; resolves explicit `ATLAS_DB_PATH`, then `ATLAS_HOME/atlas.db`, then the default `HOME/.atlas/atlas.db`; runtime persistence, not model-selected paths. |
| `src/permissions/autonomy.ts` | Operator autonomy settings; explicit CLI flow. |
| `src/permissions/grant-store.ts` | Persist grants only after the permission flow returns an explicit remember choice; the hard floor is independently checked before grant/tier shortcuts. |
| `src/permissions/sudoers-setup.ts` | Temporary restricted sudoers file for explicit operator setup; fixed system destination. |
| `src/providers/model-registry.ts` | Provider catalogue cache under Atlas home; fixed cache location. |
| `src/selfmod/ledger.ts` | Append selfmod audit record; explicit CLI workflow. |
| `src/selfmod/runner.ts` | Write proposal contents into validated scratch copy; live write only after operator approval and repository-relative path checks. Not directly exposed as an assistant tool. |
| `src/shell/file-tools.ts` | Model-reachable file read/write/edit/delete. Every target is canonicalized and checked against one shared protected-target source and configured read/write roots; mount policy consumes the same source. |
| `src/voice/backends/sherpa-onnx/wake-word.ts` | Generated keyword/probe files under the selected model data root; voice backend only. |
| `src/voice/enrollment.ts` | Private operator-enrolled voice samples under configured audio directory; no model path input. |
| `src/voice/model-manager.ts` | Download/extract/remove model assets under managed model root; explicit user setup/reset. |
| `src/voice/voice-pipeline.ts` | Temporary audio artifacts under configured audio directory; voice transcript is model input, but does not select the path. |
| `src/voice/voiceprint-store.ts` | Private voiceprint persistence under configured data root; no model path input. |

## Network and dynamic loading

| Module | Network/dynamic behavior | Model reachability |
| --- | --- | --- |
| `src/providers/openai-compatible.ts` | HTTP fetch to configured provider base URL | Model API calls are expected; endpoint comes from user config/CLI, not model output. |
| `src/providers/anthropic-compatible.ts` | HTTP fetch to configured provider base URL | Same; endpoint is user-configured. |
| `src/providers/key-validation.ts` | HTTP fetch to endpoint being configured | Triggered by user TUI key setup; endpoint is user input, not model-controlled. |
| `src/providers/model-registry.ts` | Fetch fixed `https://models.dev/api.json`, cache the response | CLI catalogue/config flow; fixed host, no model-controlled URL. |
| `src/voice/model-manager.ts` | Fetch manifest-declared voice model assets | Explicit user voice setup; URL is from bundled model manifest, not model input. |
| `src/voice/wyoming.ts`, `src/voice/wake-word-service.ts`, `src/voice/stt-service.ts`, `src/voice/speaker-verification.ts` | Connect to configured local/voice backend services | Voice subsystem; model does not choose the endpoint. |
| `src/cli.ts`, `src/tui/run.tsx`, `src/voice/cli.ts`, `src/voice/backends/sherpa-onnx/wake-word.ts`, `src/voice/voiceprint-store.ts` | Dynamic `import()` of fixed internal modules or built-ins | Static module paths only; no computed module path from model output. |

No `eval`, `new Function`, `vm.run*`, or user/model-selected dynamic import was
found by the source scan. The import-boundary test explicitly allowlists
process-spawning and direct-write modules and fails if another source module
imports these APIs.

## Evidence limits

Static search evidence does not establish that every external executable or
network host behaves benignly. Voice backends and full-access mode are explicit
operator-selected capabilities, not sandbox guarantees. The full guarded matrix
and live CLI exercises are required separately; anything not exercised there
remains unverified.
