# Atlas — how production harnesses solve command-execution safety

**Research report. No implementation.** Repo under test: `c3a597b`.
Sources: primary docs and source read directly; citations inline.

---

## 0. The problem this must solve

Atlas's gate matches command **text**. The evaluator proved that fails, twice,
and built a prototype of the obvious fix (expand shell syntax before
deny-matching) which **also failed**:

```
cd /; rm -rf *              cd ~; rm -rf *
rm -rf -- "/"                rm -rf {/,/home}
find / -delete               echo <b64> | base64 -d | bash
cp /tmp/evil.json ~/.atlas/config.json
```

`rm -rf *` expresses its target in the **process working directory**, which no
amount of argv analysis can see. And a base64 pipe makes the payload *data*.
A text-matching classifier has a structural ceiling here. Two pattern-based
fixes have now failed by measurement; that is the finding, not a detail.

---

## 1. Which production approach closes it

### Codex CLI — closes it. This is the model to copy.

From `codex-rs/linux-sandbox/src/lib.rs`:

> On Linux, `codex-linux-sandbox` applies:
> - in-process restrictions (`no_new_privs` + seccomp), and
> - bubblewrap for filesystem isolation.

So Codex is **two layers**: seccomp-bpf + `no_new_privs` for syscalls/privilege
escalation, and bubblewrap for what the filesystem *is*. On macOS it uses
Seatbelt (`/usr/bin/sandbox-exec`); Windows has `codex_windows_sandbox`.

Crucially the decision is made by the **sandbox policy, not the command string**:
read-only / workspace-write / full-access. `docs/sandbox.md`: Codex defaults to
**read-only** until a directory is explicitly trusted, and **network off by
default**. Approvals are a *separate* axis ("when you must confirm") layered on a
sandbox that already bounds the damage ("what you may do unsupervised").

**Why this closes the bypass class:** `cd /; rm -rf *` is harmless if `/` inside
the sandbox is a tmpfs with only your declared roots bind-mounted. Brace
expansion, quoting, `--`, and base64 all become irrelevant, because they cannot
manufacture a path that was never mounted. The attack stops being about *phrasing*.

### Claude Code — would share Atlas's weakness, by documented design.

Claude Code's primary mechanism is application-level allow/ask/deny — the same
category as Atlas's. The sandbox is an *optional* layer, and from the docs:

> By default, if the sandbox cannot start because dependencies are missing or the
> platform is unsupported, Claude Code **shows a warning and runs commands
> without sandboxing**. To make this a hard failure instead, set
> `sandbox.failClosed`.

It also has `allowUnsandboxedCommands`, where a command that fails under the
sandbox may be retried unsandboxed. Its prompts are titled *"Bash command
(unsandboxed)"* so you can tell.

**Verdict, tested the way the Atlas evaluator tested Atlas:** Claude Code's
approval system, on its own, is text-matching — the same category that just
failed twice here. Its sandbox would close the bypass **only when actually
active**, and it defaults to inactive *and* degrades to inactive on failure.
Atlas today is the "sandbox unavailable" case permanently.

I should be straight that Claude Code's optional sandbox *does* work when on;
my claim is about the default posture and the degradation path, both documented.

### Third parties

**Belay** wraps multiple harnesses (Claude Code, Codex, Hermes, OpenClaw) via
native hooks — it is a control plane, not a different primitive; it inherits
whatever the host harness does. Sandboxing-as-a-service for agents exists
(container/socket providers) but I did not verify current providers, and Atlas's
Fedora/Linux-first posture makes an external service a poor default anyway.

---

## 2. The primitives that matter

| Primitive | Role | Notes |
|---|---|---|
| **bubblewrap (`bwrap`)** | filesystem/network isolation via user namespaces + bind mounts | Atlas-relevant: the evaluators already used it to prove destruction safely |
| **seccomp-bpf** | syscall filtering | In Codex as in-process `no_new_privs` + seccomp |
| **`no_new_privs`** | blocks setuid escalation | Cheap, pairs with seccomp |
| **Landlock** | unprivileged file access control | Codex ships it (`landlock::apply_permission_profile_to_current_thread`) |
| **Namespaces** (`CLONE_NEWUSER/NS/MNT/PID/UTS`) | isolation substrate | Kernel-version dependent; userns restricted on some distros |
| **macOS Seatbelt** (`sandbox-exec`) | macOS equivalent | Codex requires `/usr/bin/sandbox-exec` |

### Two defensive details Codex does that are worth copying

1. **PATH-hijack resistance.** Codex prefers "the first `bwrap` found on `PATH`
   **outside the current working directory**" — a workspace containing a
   `bwrap` binary cannot hijack the sandbox. (`linux-sandbox/README.md`)
2. **Vendored + digest-verified binary.** Codex vendors bubblewrap
   (`vendor/bubblewrap/bubblewrap.c`) and falls back to a **bundled** binary
   when none is on PATH, with
   `BUNDLED_BWRAP_DIGEST_VERIFICATION_FAILURE_EXIT_CODE = 8` — a tampered
   bundled binary is a hard failure, not a warning.

Atlas is npm-distributed, so it cannot easily vendor a compiled C binary; the
achievable equivalent is **absolute, non-`$PATH` resolution + refuse if
unresolvable**.

---

## 3. Fail closed — the principle, and where Atlas is worst

Every Atlas bypass had one shape: **something silently had less protection than
it appeared to.**

- a durable grant silently skipped the floor check
- a second front-end (`atlas chat`) silently never wired the floor in
- a hand-edited `autonomy.json` silently skipped the ceremony
- the registry cache could be read mid-write and parse as empty

| | Unavailable sandbox behaviour |
|---|---|
| **Codex** | Mandatory. Bundles a verified fallback binary; a digest failure exits 8. Never "warn and run anyway". |
| **Claude Code** | Warns and runs unsandboxed by default; `sandbox.failClosed` opt-in. |
| **Atlas today** | No sandbox, so nothing to fail closed from — the gap is invisible. |

**Recommendation: fail closed, and make the absence visible rather than
imperceptible.** Atlas should print the active protection mode at startup and in
`atlas status`. A user who cannot see that they are unprotected is in the same
position as one silently running unsandboxed.

---

## 4. Proposed architecture for Atlas

### Primitive

**bubblewrap on Linux**, with `no_new_privs` + a seccomp filter where
available. Fedora ships bubblewrap in the base repos, so the dependency
assumption holds for Atlas's stated primary platform. Resolve `/usr/bin/bwrap` by
absolute path (Codex's PATH-hijack defence), and **refuse dangerous execution
if it cannot be resolved** rather than running unprotected.

### Default scope

Mirror Codex's profiles:

| Profile | Mounts | Network |
|---|---|---|
| `read-only` (default) | system roots ro; project ro | off |
| `workspace-write` | project rw; everything else ro | off unless granted |
| `full-access` | host filesystem | user choice |

`workspace-write` is the default *once a project is trusted* — it satisfies
Atlas's day-one premise ("do anything the user can do") by **scoping** rather
than by narrowing capability: inside its mounts the agent is unconstrained.

**Escaping the scope** (other project paths, `~/.ssh`, `/etc`, network, package
installs) is an explicit, audited grant — reusing the existing autonomy-level
friction, not replacing it.

### Degraded posture when the primitive is unavailable

**Refuse the dangerous class; do not invent a weaker permission to avoid
refusing.** Concretely, without bwrap: keep the current hard-deny list as a
*heuristic* for clear catastrophic commands, and **refuse to execute anything
the classifier cannot positively clear** — i.e. fail toward asking, not toward
running. State the mode in one line at startup: "sandbox unavailable —
dangerous commands will be refused, not sandboxed."

### Cost and risk — read this before committing

- **Large.** This is a rewrite of execution, not a config change. `ShellSession`,
  `ShellTool`, grants, and the audit path all assume a host shell.
- **Real risk: a sandbox is a new privilege boundary.** Bugs in the mount
  configuration are *more* dangerous than today's gaps, because they look like
  protection. Needs its own adversarial review before it ships — the same
  treatment `safety-deep` gave the previous fix.
- **Distribution.** npm cannot vendor a compiled binary; Atlas depends on the
  OS package. Acceptable Fedora-first, needs an honest message elsewhere.
- **Windows/macOS** need Seatbelt/Windows equivalents or an explicit "unsupported
  → refuse" mode. macOS Seatbelt is well-trodden and probably the cheapest
  second target.
- **Effort:** days, not hours, plus review. Compare: the two pattern fixes that
  failed cost less and produced nothing.

---

## 5. What survives from Atlas's current system

| Component | Verdict |
|---|---|
| **Hard floor** | **Keep, but demote to defence-in-depth.** With a sandbox, `rm -rf /` is already impossible; the floor becomes a cheap backstop for degraded mode. |
| **Autonomy levels** | **Keep as-is.** "How often may it ask" and "what can it reach" are orthogonal; Codex runs both axes. |
| **Durable grants** | **Keep, but scope to the sandbox profile.** A grant should widen mounts, not bypass checks. The current design (grant → tier 0 → floor never consulted) must not survive. |
| **Audit log** | **Keep and enrich** — record sandbox profile, mounts, and escalations. Fix its self-erasure separately; it gets *worse*, not better, with a sandbox. |
| **Risk classification** | **Substantially demoted.** Useful for choosing *how much* friction to apply inside the sandbox; no longer load-bearing for safety. Much of its rule surface was compensating for the absent sandbox. |
| **Plain-language explanations** | **Keep.** It's a UX asset, unrelated to the boundary. |

The honest summary: **Atlas has been running a permission system doing the job
of a sandbox.** Most of the rule surface exists because the destructive target
was always visible. Once it isn't, the classification can shrink to "how much
friction", which is a much smaller and more honest thing to maintain.

---

## 6. Proof-of-closure status — NOT DONE, and it must be before this is settled

I ran a partial check with `bwrap` 0.11.0, tmpfs root, real data at
`/tmp/ax/root`:

```
cd / ; rm -rf *            exit=1
rm -rf -- "/"              exit=1
[real filesystem] IMPORTANT-DATA survived
```

and with a workspace/secret mount split, the secret directory and workspace file
both survived, with `/` inside the sandbox containing only what I bind-mounted.

**This is a positive control, not the required proof.** It shows the *mechanism*
works. It does not yet test the real bypass list against a *proposed Atlas
configuration*, and it is not a substitute for an adversarial pass. Before this
recommendation is treated as settled, someone should re-run the full evaluator
bypass set — including `rm -rf {/,/home}` and the base64 payload — against an
Atlas-shaped sandbox, and attempt escapes: symlinks, `/proc`, write-then-exec,
`PATH` manipulation, and read-only-bind bypass.

## Uncertainty

Flagged rather than smoothed over:
- I did not read Codex's `bwrap.rs` argument construction in full; the mount
  semantics are inferred from its module docs and README.
- I did not verify current sandboxing-as-a-service providers.
- Codex's *Windows* path is asserted from module names, not read.
- The bwrap checks above are my own, not Codex's; they establish feasibility,
  not that Codex's exact configuration is safe.

## Recommendation

Adopt the Codex model: **bwrap + seccomp + `no_new_privs`, read-only by
default, workspace-write once a project is trusted, absolute-path bwrap
resolution, and refuse rather than degrade.** Then commission the same
adversarial review we ran on the last fix — because the last fix passed every
test we had and still shipped broken.

---

# Addendum — open-source harnesses (OpenClaw, Hermes, and the pattern they share)

Added after code-searching four more projects. This **strengthens** the Codex
recommendation and changes one part of the Atlas proposal.

## 7. What the open-source harnesses do

### OpenClaw — container-based, with a *path-level* access gate

Not bwrap. `src/agents/sandbox/docker.ts` (Docker + Podman, configurable
engine), with a backend registry ("core and plugins can register local
container, SSH, or custom sandbox providers").

The interesting part is `extensions/codex/src/app-server/sandbox-exec-server/fs-policy.ts`:

> `assertFsSandboxAccess(...)` — "Resolves request-local sandbox policy and
> asserts each requested path has the needed access."
> `ResolvedFsSandboxEntry` with `FsAccessMode`.

**OpenClaw enforces access per path, at the syscall the tool actually makes** — not by matching command text. `isToolAllowed` from `openclaw/plugin-sdk/sandbox` gates tools too. It also ships `sandbox-explain` ("resolves the effective sandbox/tool/elevated policy … and prints … a human-readable fix-it report") and `doctor` posture checks.

### Hermes — pluggable execution backends, and a tool allowlist *inside* the sandbox

`tools/terminal_tool_backends.py`:

```python
_BUILTIN_BACKENDS = "local, docker, singularity, modal, daytona, vercel_sandbox, ssh"
```

The shell is an *execution environment* you swap, not a hardcoded host shell.
Local is the default; container and cloud are configuration.

The more directly relevant finding is `tools/code_execution_tool.py`:

```python
SANDBOX_ALLOWED_TOOLS = frozenset([
    "web_search", "web_extract", "read_file", "write_file", "search_files", "patch", "terminal",
])
```

**Hermes gates which TOOLS are available inside the sandbox, not which commands
are safe.** That is the exact weakness the `tasks` report found in Atlas — it
gives the model one `shell` tool, so "create these two files" produces nothing.
Hermes has `read_file`, `write_file`, `search_files`, `patch` as first-class
sandboxed capabilities.

### The convergent pattern

Across Codex, Claude Code, OpenClaw and Hermes, four independent teams converged on
the same shape:

1. **Execution happens somewhere the agent does not control** — namespace/
   container/VM — rather than being filtered on the host.
2. **Capability is scoped, not eliminated.** "Do anything the user can do"
   survives by *scoping where*, not by removing what.
3. **Access is asserted per path/per operation**, not inferred from a string.
4. **The tool surface is itself the capability boundary.**

## 8. What this changes in the Atlas proposal

**Unchanged:** the primitive recommendation. bwrap + `no_new_privs` + seccomp,
read-only by default, workspace-write once trusted, absolute-path bwrap
resolution, refuse rather than degrade. Codex remains the closest match and
OpenClaw/Hermes corroborate it.

**Changed — the proposal is stronger than I first wrote it.** Two additions:

**(a) Add a tool allowlist, and make it the primary fix for the "one shell tool"
problem.** The `tasks` report found Atlas cannot do ordinary work: asked to
create two files and run tests, it narrated a plan and produced zero files. That
is a *capability* failure, and no sandbox fixes it. Adopting Hermes's shape —
`read_file`, `write_file`, `search_files`, `patch` as sandboxed capabilities
alongside `shell` — is likely the highest-value change available, and it is
independent of the sandbox work. It also shrinks the rule surface: a
`write_file` with a path is far easier to constrain correctly than
`rm -rf` under any spelling.

**(b) Model the sandbox as a pluggable backend, like Hermes.** Atlas's npm
distribution and "any machine" premise argue against hard-wiring bwrap. A
`ExecutionEnvironment` interface with `local` (current, degraded) and
`bwrap` (Linux) implementations, extensible to Docker/Podman later, keeps the
"fail closed" posture honest per backend and leaves a path to macOS Seatbelt
without a rewrite. Hermes's `_BUILTIN_BACKENDS` list is the pattern.

## 9. Unchanged conclusion

Atlas has been running a permission system doing the job of a sandbox, **and**
giving the model a single tool where production harnesses give a capability
set. Both are wrong in the same direction — asking the model to be careful
about a boundary it cannot perceive.

The evaluation already measured the cost of the first half: two pattern fixes,
both built, both shipped broken, both caught only by adversarial agents. The
second half is what the `tasks` report measures as "zero files produced."

## 10. Revised recommendation

1. **Tool set first** (Hermes pattern) — highest value, smallest change, fixes
   the measured "Atlas can't do the job" failure.
2. **Sandbox second** (Codex pattern) — bwrap, pluggable backend, fail closed.
3. Re-run the evaluator's full bypass set against the real configuration, plus
   escape attempts (symlink, `/proc`, write-then-exec, `PATH`, read-only-bind
   bypass), and adversarially review the sandbox itself — the last fix passed
   every test we had and still shipped broken.

## Uncertainty, extended

- I read module headers and signatures, not full implementations, for OpenClaw
  and Hermes. The *shapes* are clear; I have not verified their correctness.
- I did not examine opencode or pi's execution layer in this pass.
- `_BUILTIN_BACKENDS` shows capability, not that those backends are equally
  safe or equally maintained.
- My bwrap checks remain a positive control, not the required proof.
