RESEARCH PHASE - command-execution safety. Report only. NO implementation, NO code changes.

## The problem, established by evidence (do not re-derive, do not re-litigate)
Atlas's dangerous-command gate is bypassed because it matches command TEXT while
bash acts on STATE. Confirmed bypasses, reproduced by two independent agents:
  cd /; rm -rf *                 <- target expressed via working directory, not text
  cd ~; rm -rf *
  rm -rf -- "/"
  rm -rf {/,/home}
  find / -delete
  echo <base64> | base64 -d | bash   <- payload is data, invisible to any parser
  cp /tmp/evil.json ~/.atlas/config.json

CRITICAL: an obvious fix was already BUILT AS A PROTOTYPE and MEASURED, and it
FAILED. Expanding parsed shell structure (braces, $(...), quote stripping, --
separation) before deny-matching survives every one of the above, because
`rm -rf *` depends on cwd, which no argv expansion can see. See
/tmp/atlas-eval/reports/safety-deep.md - READ IT FIRST, it is the core input.

DO NOT propose another regex/pattern patch. The goal is to understand how
production harnesses solve this at a different layer.

## Deliverable
Write to /tmp/atlas-safety-research/REPORT.md. Report only - no implementation.

The report MUST answer:

1. Which production harness's approach most directly closes the cd-then-glob /
   working-directory-state class, and WHY. Compare Codex CLI (kernel-enforced
   sandbox, namespaces + seccomp-bpf, macOS Seatbelt, read-only /
   workspace-write / full-access profiles) against Claude Code (application-level
   allow/ask/deny plus an OPTIONAL bwrap+seccomp layer). State which of the two,
   tested the way the Atlas evaluator tested Atlas, would share the same
   structural weakness. Read actual source/docs - do not rely on memory.
   Also cover Belay and any agent-specific sandbox-as-a-service tooling you find.

2. The concrete primitives: Linux namespaces, seccomp-bpf, bubblewrap/bwrap,
   and filesystem scoping via bind mounts. Verify current support status; note
   anything Linux-kernel-version specific. Cover hard-coded non-$PATH resolved
   paths to trusted sandbox binaries as a PATH-hijack defence, if it is real.

3. FAIL CLOSED. Every Atlas bypass shared one shape: something silently had less
   protection than it appeared to. Document precisely how Codex treats sandbox
   unavailability (mandatory) versus Claude Code's documented "continue
   unsandboxed if the tooling isn't available" fallback. Recommend what Atlas must
   do - refusal, not a silent downgrade.

4. A concrete architecture proposal for Atlas specifically: which primitive(s),
   the DEFAULT mount/access scope (project dir plus explicitly granted paths is a
   starting point), how genuinely-needed full-system access is still granted -
   tying into the existing hard floor and autonomy levels rather than replacing
   them - and the degraded posture on a machine without the primitive, consistent
   with fail-closed. Do not invent a weaker allowance to avoid refusing.
   Atlas ships as an npm package for "any machine" and is Fedora/Linux-first;
   check whether that reasoning holds rather than assuming it.

5. What SURVIVES from the current system. For each of: risk classification,
   autonomy levels, the audit log, the hard-floor concept, durable grants -
   say whether it still earns its place ON TOP of a sandbox layer, or whether it
   was only ever compensating for the absence of one and can be simplified.
   Be concrete, not diplomatic.

## Scope discipline
OUT OF SCOPE - do not re-litigate, they get fixed either way: the self-erasing
audit log, the dishonest gate_path column, missing dist/ protection, the
non-interactive readline confirmation bug, scoped-approval being a no-op.

If you run any test, work ONLY in a scratch copy under /tmp/atlas-safety-research/.
NEVER modify /home/titan/atlas. NEVER run a destructive payload on the real
filesystem. If you demonstrate destruction, use bwrap with a tmpfs root, exactly
as the Atlas evaluators did.

## Method
Do real research: web search for current sources, and read actual source where
available. Prefer primary sources (the repos, the docs) over commentary. Where
you are uncertain, say so explicitly rather than smoothing it over.

WRITE THE REPORT AS SOON AS YOU HAVE THE COMPARISON AND THE PROPOSAL, then
refine it. Do not let the process die holding your findings - three earlier agents
survived only because they wrote early.