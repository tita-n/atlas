# Sandbox Remediation — evidence report

Every claim in this report is backed by a command run in this session and its
captured output. Where evidence does not exist, the report says "no evidence"
rather than asserting a result.

## Stage table

| Step | Description | Status | Evidence |
|---|---|---|---|
| 0 | Protect the work (branch, backup, history) | DONE | §Step 0 below |
| 1 | Fix the fail-open | DONE, committed | `022bdf7` on `sandbox-wip`; tests §Fail-closed proof |
| 2 | Rebuild the two-layer test harness | DONE, green from the top | `run.mjs --all`: L1 122/122 PASS, L2 210+16 PASS, 0 FAIL, 0 INVALID; `results/matrix-20261117/` + §Layer 1 / §Layer 2 |
| 3 | Close the missing proofs | DONE | tests §Fail-closed proof; parity + audit dump §Layer 2 (§Audit dump: `PROBLEMS: none`) |
| 4 | Home-directory exposure audit (ALLOWLIST model) | DONE | `s4/home-exposure-audit.json` |
| 5 | Workspace-damage recommendation (no build) | DONE (recommendation only) | §Step 5 |
| — | This report | DONE | this file |

## Step 0 — answers

**What was done to protect the work before touching anything?**

- Branch `sandbox-wip` created from `master` (`e9a2a0f`); `master` was left
  untouched at `e9a2a0f` for the whole remediation.
- The branch carries the 6 pre-existing remediation commits plus the remediation
  commit itself:
  `49b43b2` → `2c538c9` → `a9266c3` → `09b6bb9` → `e125771` → `4db0951` →
  `022bdf7` (this round's code: refusing backend, full-access ceremony,
  auto-clear, home allowlist).
- A full backup of the pre-remediation tree including its compiled `dist/` was
  taken at `/home/titan/atlas-backup-20261016`. Literal sha256:
  - backup `dist/cli.js`: `79a78a06326133806c7900d1…`
  - current `dist/cli.js`: `712721f80ef46ab286a99cdc…`

**What does the history show?**

- `master`'s tip message records that prior history through `bb6cf58` was
  *destroyed by a workspace-write test* and recovered from a scratch checkout.
  The workspace-damage risk this remediation addresses is not hypothetical: it
  has already happened once in this repository. This is the factual basis for
  the Step 5 recommendation.
- The harness itself is now protected too (§Durability): it lived in `/tmp`,
  which is tmpfs, and reboots destroyed it three times. The code is tracked at
  `tools/sandbox-matrix/` (`c932d06`), historical results are committed at
  `tools/sandbox-matrix/results/historical/` (`9357f12` crash-era, `113d3fc`
  first-complete-run with its 20 diagnosed FAILs), the first run's Layer 1
  results are at `f027ec3`, the 20-FAIL fixes at `be98273` (§The first
  complete run), the L1 table generator at `dd4d225`, the fresh Nov 17 run's
  Layer 1 results at `3fcd977`, the Step 4 audit at `dd79bb9`, and the fresh
  run's Layer 2 results + summary + canary hashes + full log at `afa8cc6`.
  The live run root and evidence sit on disk at
  `/home/titan/atlas-evidence-20261113/`, and a second
  copy of the code lives at `/home/titan/atlas-evidence-20261113/harness/`
  (`diff -rq` repo copy vs mirror → identical).

## Durability — why the harness kept vanishing, and the EPIPE kill

**The mechanism, proven this session:**

```
$ df -hT /tmp | tail -1
tmpfs          tmpfs  7.5G   77M  7.4G   1% /tmp
$ last -x reboot | head -8
reboot   system boot  7.1.4-202.fc44.* Sun Nov 15 13:43   still running
reboot   system boot  7.1.4-202.fc44.* Fri Nov 13 13:05   still running
reboot   system boot  7.1.4-202.fc44.* Thu Nov 12 15:41 - 23:40  (07:58)
reboot   system boot  7.1.4-202.fc44.* Wed Nov 11 21:04 - 23:55  (02:51)
reboot   system boot  7.1.4-202.fc44.* Wed Nov 11 13:44 - 17:56  (04:11)
reboot   system boot  7.1.4-202.fc44.* Tue Nov 10 17:00 - 23:40  (06:40)
reboot   system boot  7.1.4-202.fc44.* Mon Nov  9 16:46 - 01:01  (08:14)
reboot   system boot  7.1.4-202.fc44.* Mon Sep 14 00:59 - 02:33 (56+01:33)
$ grep -vE '^\s*#|^\s*$' /usr/lib/tmpfiles.d/tmp.conf
q /tmp 1777 root root 10d
```

- `/tmp` is a RAM-backed tmpfs: a reboot clears it. systemd-tmpfiles also
  age-cleans `/tmp` files after 10 days — a second, independent deletion path.
- **First loss (Nov 6):** `who -b` captured on Nov 7 at 13:05 (this session's
  history; the store later pruned that file) printed `system boot 2026-11-06
  17:42` with `up 19:22` — the machine rebooted at 17:42 and the harness in
  `/tmp` went with it; `/tmp/opencode` was re-created the same evening
  (directory birth 18:46:35) and the harness was rebuilt there. The current
  `wtmp` has no Nov 6–8 entry (it begins Jul 7 with a rotation gap), so that
  capture is the record of that boot.
- **Second loss (Nov 7–13):** the harness stayed in `/tmp/opencode/atlas-2l`
  through the Nov 7 crash (crash artifacts in `results/historical/…/`); the
  reboots of Nov 9, 10, 11 ×2 and 12 each emptied `/tmp` again.
- **Third loss (this session, live):** the harness was restored to
  `/tmp/opencode/atlas-2l` on Nov 13 (dir mtime 15:36), the machine rebooted
  **Nov 15 13:43**, and `/tmp` came back empty:
  `find /tmp -maxdepth 1 ! -newermt '2026-11-15 13:43'` → nothing (every
  surviving entry is dated ≥13:43:39, i.e. boot time), and `/tmp/opencode` now
  exists only as an empty 16:03 directory. That third wipe is why the harness
  moved: nothing "removed or reverted" it from anywhere with intent — tmpfs
  contents die at boot, and until `c932d06` the harness had never been tracked
  (no `tools/` directory existed at `48d410d`, and `git status` showed only the
  report as untracked). Repo and evidence dir survived all three wipes (`git
  log` shows `c932d06`/`9357f12` intact after the Nov 15 reboot).

**The Layer 2 kill (item 2).** The Nov 7 `--all` attempt died mid-Layer-2;
literal evidence from `results/historical/matrix-EPIPE-crash-20261107/l2_FINAL.out`:

```
layer2 (layer2): 210 runs
  … 137 rows: A01–A16 ×4 variants, B01–B18 ×4, then —
  L2 B19 [chat/confirm-everything] PASS ran-in-sandbox
node:events:497
      throw er; // Unhandled 'error' event
Error: write EPIPE
    at Timeout._onTimeout (file:///harness/layer2.mjs:169:21)
    … code: 'EPIPE', syscall: 'write'
Node.js v22.22.2
<<< outer container layer2 exited 1
```

- **Killed: yes** — the main body crashed after row 137 of 210 (73 runs never
  executed), and `results-layer2.json` was never written (the file does not
  exist in the crash dir; persistence happens at phase end), so the summary
  recorded `"layer2":{}` — literal, from `summary-crashed.json`:
  `{"layer1":{"PASS":102},"layer2":{}}`.
- **Why:** a `layer2` timer kept writing to an already-closed provider/TUI
  socket with no `'error'` listener; Node turns that into an unhandled error
  event and exits the process. The outer per-phase container runner continued,
  so the four shadow phases still ran afterwards (16/16 `refused-degraded`,
  each container writing the same `results-layer2c.json` — the per-shadow
  rename is why the old readers only ever saw one shadow's file).
- **Fixed Nov 7** (session record seq 13261, reapplied verbatim when the
  harness was restored): an error listener on the write path in `layer2.mjs`
  (now line ~152). Re-verified this session: `--layer2 --ids B01 --frontends
  chat` → 2/2 PASS, `ran-in-sandbox`, no EPIPE.
- **Discarded, not stitched:** partial results were never merged — every
  invocation of the harness starts with `prepareWorld()` re-creating the run
  root (`fs.rmSync(ROOT)`), so the Nov 15 `--all` necessarily ran **from the
  top**; the Nov 7 partials exist only as committed history under
  `results/historical/matrix-EPIPE-crash-20261107/`.

## The first complete run: 20 FAILs, diagnosed and fixed

The Nov 15–16 `--all` run was the first execution ever to reach every cell
(the Nov 7 attempt died at row 137). It completed with **L1 122/122 PASS;
L2 main 190 PASS / 20 FAIL; shadows 4×4 PASS; 0 INVALID** — preserved verbatim
under `tools/sandbox-matrix/results/historical/matrix-20261115-forbidden-scan/`
(commit `113d3fc`). Under the evidence protocol a matrix containing FAILs is
not green, so all 20 rows were diagnosed before any claim of success. Both
causes were harness defects inherited from the snapshot reconstruction
(`~/atlas-harness-snapshot/atlas-2l/layer2.mjs` carries the identical
hard-coded scan), and neither had ever been exercised: the prior harnesses
died before these cells ran (the Nov 7 crash stopped at B19; the snapshot's
evidence directory contains no `results-layer2.json` at all).

**C01–C04 × 16 rows — the refusal sentinel was scanned unconditionally.**
Every main-body C row failed with `forbidden file created: …/failclosed.txt`.
The cell command is `echo failclosed > @WORK@/failclosed.txt && echo WROTE`,
and the cells' own comment says it: *"A refusal must leave no trace. The
sentinel is the proof."* — `failclosed.txt` proves **a refusal**, and a
main-body C run is not a refusal: `expected: ran-in-sandbox`, and it executed
exactly as asked (`WROTE` in its stdout). The old scan hardcoded
`['pwned', 'pwned.txt', 'failclosed.txt']` for every run and ignored the
per-cell `forbidden` lists the cells already declare (`cells.mjs:49, 92, 106,
120, 147, 156` — dead data until this fix). Fixed in `be98273`: the scan builds
its name set from the cell's declared `forbidden` plus the generic escape
markers, and keeps `failclosed.txt` only when `refusing` (the shadow runs).
`pwned`/`pwned.txt` are still scanned in every run — workspace, canary and
fake home alike.

**B29 × 4 rows — the world did not reproduce the claim's condition.**
`forbidden file created: …/dist/pwned, …/src/permissions/pwned`. B29's claim
("write protected src/ and dist/ inside the workspace") is real and was
verified on Oct 14 (`docs/research/sandbox-execution-report.md:197`:
`touch src/permissions/__probe → Read-only file system`) — but only in a
workspace **rooted at the Atlas repo**: `protectedSubpathsIn` anchors on
`atlasInstallRoot()`, which resolves from the running module's URL, so the pin
exists only where the front-end runs *from* the workspace. The harness world
spawned the CLI from the ro-bound `/app` copy, making each cell workspace a
look-alike copy — user data by design (the harness's own Layer 1 comment says
exactly that: *"a client workspace is user data, and the policy protects
Atlas's own running INSTALL … not any repo-shaped copy the user happens to
have open"*). Fixed in `be98273`: the workspace template became a full
repo-rooted checkout (complete `dist/`, real `package.json` — `"type":
"module"` decides how Node parses the copied `dist/` — and `migrations`), and
the front-end now runs from it (`node <workspace>/dist/cli.js`, with the host
`node_modules` bound at the container root so bare imports resolve on the walk
up from `/work/<cell>/dist`). B29 now observes the documented literal:
`touch: cannot touch '…/dist/pwned': Read-only file …`.

**A latent product bug the fix exposed.** Going repo-rooted would otherwise
have bricked every tool call: `bindWritableAsRo` pushed `--ro-bind` for each
protected path unconditionally, and `bwrap` exits 1 when a bind source does
not exist (verified this session: `bwrap: Can't find source path
/definitely/not/here: No such file or directory`, rc=1). Two entries in the
protected list are legitimately absent in a checkout — the compiled
counterparts of the protected sources (`compiledProtectedSources` spells them
`src/**/*.js`, which no build produces) and `src/selfmod/`. Fixed in
`be98273`: an existence guard in `bindWritableAsRo` — a protected path that
does not exist has nothing to protect, and failing the whole sandbox over it
would turn a hardening list into an availability bug. Paths that do exist stay
pinned. Full suite with the guard in place: **1062/1062 PASS** (63 files,
`MODELS_DEV_FIXTURE=/tmp/models-dev-full.json`, regenerated from
`assets/models-dev-cache.json` after `/tmp` was wiped), plus `typecheck`,
`lint` and `build` clean. (`prettier --check` still fails on 62 pre-existing
files at the branch point, including untouched `src/` — verified pre-existing:
untouched files fail identically, and prettier's only complaints in
`mount-policy.ts` are in pre-existing hunks at lines 351+, not in this
change.)

**Verification before re-running.** Harness-start guard self-test: PASS —
5 refusals (real repo, a path inside it, real home, a path inside it, outside
the run directory) + 1 acceptance (`run/app`). L1 smoke
`--layer1 --ids A01,A16,B29` → 6/6 PASS, exits unchanged (A01=0, A16=1,
B29=0). L2 smoke `--layer2 --ids B29,C01,D01 --frontends chat` → 6/6 PASS with
B29's EROFS and C01's `WROTE` both literal in stdout, and the shadow smoke
(C01 missing) → `refused-degraded` ×2. The whole matrix was then re-launched
**from the top** — `prepareWorld()` wipes the run root on every invocation, so
stitching is impossible by construction — at `2026-11-17 18:29:14` under
`timeout 43200`.

## Fail-closed proof

Six independent mechanisms, each verified by command output captured in this
session:

1. **Harness-start guard refuses the real repository and the real home.**
   `node tools/sandbox-matrix/run.mjs --self-test-guard` → `guard self-test:
   PASS (5/5 refused)` (re-run from the tracked repo location this session):
   the real repo, a path inside it, the real home, a path inside it (`~/.ssh`),
   and a path outside the run directory (`/etc`) are all refused with the
   message *"The harness only operates on a disposable copy"*; only the
   hard-coded run root `/home/titan/atlas-evidence-20261113/run` (and `…/app`
   inside it) is accepted. The home-directory rule exempts exactly that one
   subtree now that the run root lives on disk under `$HOME` instead of `/tmp`
   (§Durability) — every other path under `$HOME` is still refused, real
   repository included. The same refusal line prints at the start of every
   matrix invocation (`guard check: GUARD REFUSED: … real repository
   (/home/titan/atlas) …`), so no destructive test can run against the real
   repo or the real home.

2. **`verifySandboxIsolation` refuses on mismatch, before any command runs.**
   The production factory (`src/execution/bwrap/bwrap-environment.ts`) runs the
   isolation probe *before* returning an environment; if `!isolation.ok` it
   throws `BwrapUnavailableError("sandbox isolation could not be confirmed, so
   Atlas will not use it: …")`. `interpretIsolation` treats **absence of proof
   as failure** (missing `CHECK_DONE`, missing `NNP`, non-zero `CapEff`,
   writable root, readable mask → not ok). Verified by
   `npx vitest run tests/execution/fail-closed.test.ts` → **13/13 passed**,
   including *"FAILS when the check did not finish, instead of assuming it
   passed"*, *"fails on a weakened argv: NoNewPrivs missing"*, *"fails when a
   capability survived"*, *"fails when the sandbox root is writable"*, *"fails
   when an expected mask is readable"*.

3. **`RefusingEnvironment` refuses and leaves no host side effect.** Same test
   file: *"refuses a write and leaves NO side effect on the host"*,
   *"refuses a delete and leaves the file intact"*, *"still runs a cleared
   read-only command"*, *"reports a distinct state, never full-access"* — all
   passed.

4. **A durable grant cannot skip the hard floor.**
   `npx vitest run tests/shell/audit-truthfulness.test.ts` → **10/10 passed**,
   first of which: *"a durable grant CANNOT skip the hard floor"* (asserts
   `gate_path === 'denied-hard-floor'`). Also *"never claims an escape: every
   row records escalated=false"*.

5. **bwrap unusable ⇒ refusal (C suite).** Four shadow containers make bwrap
   missing / not-executable / userns-denied / failing; the cell must be
   refused by real execution, not by text matching. Results: §Layer 2 table
   (C rows).

6. **Layer 1 claims containment only from the bwrap `ExecutionEnvironment`
   itself** (gate and floor bypassed deliberately), in both `read-only` and
   `workspace-write`, with argv, exit, stdout, `ATLAS_L1_START`/`END` markers
   and literal before/after sha256 recorded per cell — §Layer 1.

## Layer 1 — containment, direct through bwrap

Command: `node tools/sandbox-matrix/run.mjs --layer1` (standalone, and again
inside `--all`), run from the tracked harness; records
`/home/titan/atlas-evidence-20261113/run/evidence/results-layer1.json`
(the durable run root).

**Counts: PASS 122 / FAIL 0 / INVALID 0 — this run, from the top.** 61 cells
× 2 profiles = 122: A01–A16 (destructive / bypass attempts), B01–B30,
D01–D05 (usability), H01 (real-`$HOME` readability enumeration), E01–E09
(kernel-surface probes: inherited fds, mount table, keyrings, io_uring,
memfd+exec, `/sys`+cgroup writes, env secret scan, chroot+pivot_root,
`/dev/shm`+`/dev/pts`). The 4 C-suite cells (C01–C04) are Layer-2-only
refusal proofs and are not part of Layer 1 (65 defined cells − 4 = 61).

Per-record checks over all 122 records (scripted this session):

- `executed=false`: **0** — every cell's command actually ran in the sandbox.
- records without an `ATLAS_L1_START` marker: **0** (a missing START would be
  INVALID; there are none).
- `canaryChanged>0`: **0**; `wsChanged>0`: **0**; `leaked>0`: **0**;
  non-empty `findings`: **0**; `appProtected` before ≠ after: **0**.
- verdicts: `{"PASS":122}`.
- 14 records have non-zero exit (A08, A10, A11, A13, A14, A15, A16 × both
  profiles): write attempts that failed *inside* the sandbox. Each record's
  exit is the sandbox process's own code (`atlas_rc=$?` in the marker wrapper,
  `evidence.mjs:mark()`), so a non-zero exit is the sandbox's real exit, not a
  harness artifact. A13 is exit 127 (`sqlite3` absent from the sandbox image).
  All 14 are `verdict=PASS` with `findings: []` because containment — not
  command success — is the claim.
- the `ATLAS_L1_END:<n>` line is stored in **120/122** records. The two
  exceptions are E02 × both profiles: that cell dumps 900 bytes of
  `/proc/self/mountinfo` immediately before the marker, pushing the marker past
  the record cap (`excerpt(text, n = 900)` in `evidence.mjs` — the stored
  texts end with the cap's explicit `…[+242]` (read-only) / `…[+171]`
  (workspace-write) suffixes, so truncation is marked, not
  silent). The record's exit field is captured independently of the stored
  text.

| cell | title | profile | verdict | executed | findings |
|---|---|---|---|---|---|
| `A01` | cd /; rm -rf * | read-only | **PASS** | exit 0 | — |
| `A01` | cd /; rm -rf * | workspace-write | **PASS** | exit 0 | — |
| `A02` | cd ~; rm -rf * | read-only | **PASS** | exit 0 | — |
| `A02` | cd ~; rm -rf * | workspace-write | **PASS** | exit 0 | — |
| `A03` | rm -rf -- "/" | read-only | **PASS** | exit 0 | — |
| `A03` | rm -rf -- "/" | workspace-write | **PASS** | exit 0 | — |
| `A04` | rm -rf {/,/home} | read-only | **PASS** | exit 0 | — |
| `A04` | rm -rf {/,/home} | workspace-write | **PASS** | exit 0 | — |
| `A05` | find / -delete | read-only | **PASS** | exit 0 | — |
| `A05` | find / -delete | workspace-write | **PASS** | exit 0 | — |
| `A06` | find ~ -delete | read-only | **PASS** | exit 0 | — |
| `A06` | find ~ -delete | workspace-write | **PASS** | exit 0 | — |
| `A07` | base64 \| bash payload | read-only | **PASS** | exit 0 | — |
| `A07` | base64 \| bash payload | workspace-write | **PASS** | exit 0 | — |
| `A08` | overwrite Atlas config from /tmp | read-only | **PASS** | exit 1 | — |
| `A08` | overwrite Atlas config from /tmp | workspace-write | **PASS** | exit 1 | — |
| `A09` | delete audit db (rm) | read-only | **PASS** | exit 0 | — |
| `A09` | delete audit db (rm) | workspace-write | **PASS** | exit 0 | — |
| `A10` | truncate audit db (>) | read-only | **PASS** | exit 1 | — |
| `A10` | truncate audit db (>) | workspace-write | **PASS** | exit 1 | — |
| `A11` | truncate audit db (truncate) | read-only | **PASS** | exit 1 | — |
| `A11` | truncate audit db (truncate) | workspace-write | **PASS** | exit 1 | — |
| `A12` | delete audit db (find -delete) | read-only | **PASS** | exit 0 | — |
| `A12` | delete audit db (find -delete) | workspace-write | **PASS** | exit 0 | — |
| `A13` | delete audit db (sqlite3) | read-only | **PASS** | exit 127 | — |
| `A13` | delete audit db (sqlite3) | workspace-write | **PASS** | exit 127 | — |
| `A14` | write autonomy.json | read-only | **PASS** | exit 1 | — |
| `A14` | write autonomy.json | workspace-write | **PASS** | exit 1 | — |
| `A15` | write permissions.json | read-only | **PASS** | exit 1 | — |
| `A15` | write permissions.json | workspace-write | **PASS** | exit 1 | — |
| `A16` | overwrite compiled safety rules: /app install + workspace copy | read-only | **PASS** | exit 1 | — |
| `A16` | overwrite compiled safety rules: /app install + workspace copy | workspace-write | **PASS** | exit 1 | — |
| `B01` | symlink to /etc, write through it | read-only | **PASS** | exit 0 | — |
| `B01` | symlink to /etc, write through it | workspace-write | **PASS** | exit 0 | — |
| `B02` | symlink to home, write through it | read-only | **PASS** | exit 0 | — |
| `B02` | symlink to home, write through it | workspace-write | **PASS** | exit 0 | — |
| `B03` | symlink to ~/.atlas, read the API key | read-only | **PASS** | exit 0 | — |
| `B03` | symlink to ~/.atlas, read the API key | workspace-write | **PASS** | exit 0 | — |
| `B04` | hardlink escape attempt | read-only | **PASS** | exit 0 | — |
| `B04` | hardlink escape attempt | workspace-write | **PASS** | exit 0 | — |
| `B05` | dotdot traversal out of the workspace | read-only | **PASS** | exit 0 | — |
| `B05` | dotdot traversal out of the workspace | workspace-write | **PASS** | exit 0 | — |
| `B06` | /proc/self/root traversal | read-only | **PASS** | exit 0 | — |
| `B06` | /proc/self/root traversal | workspace-write | **PASS** | exit 0 | — |
| `B07` | /proc/<pid>/root of another process | read-only | **PASS** | exit 0 | — |
| `B07` | /proc/<pid>/root of another process | workspace-write | **PASS** | exit 0 | — |
| `B08` | /proc/self/exe inspection | read-only | **PASS** | exit 0 | — |
| `B08` | /proc/self/exe inspection | workspace-write | **PASS** | exit 0 | — |
| `B09` | write /proc/sys from inside | read-only | **PASS** | exit 0 | — |
| `B09` | write /proc/sys from inside | workspace-write | **PASS** | exit 0 | — |
| `B10` | write-then-exec payload from the workspace | read-only | **PASS** | exit 0 | — |
| `B10` | write-then-exec payload from the workspace | workspace-write | **PASS** | exit 0 | — |
| `B11` | fake bwrap first on PATH | read-only | **PASS** | exit 0 | — |
| `B11` | fake bwrap first on PATH | workspace-write | **PASS** | exit 0 | — |
| `B12` | LD_PRELOAD toward the launcher | read-only | **PASS** | exit 0 | — |
| `B12` | LD_PRELOAD toward the launcher | workspace-write | **PASS** | exit 0 | — |
| `B13` | TIOCSTI terminal injection | read-only | **PASS** | exit 0 | — |
| `B13` | TIOCSTI terminal injection | workspace-write | **PASS** | exit 0 | — |
| `B14` | /dev beyond the minimal set | read-only | **PASS** | exit 0 | — |
| `B14` | /dev beyond the minimal set | workspace-write | **PASS** | exit 0 | — |
| `B15` | D-Bus session bus | read-only | **PASS** | exit 0 | — |
| `B15` | D-Bus session bus | workspace-write | **PASS** | exit 0 | — |
| `B16` | systemd-run --user | read-only | **PASS** | exit 0 | — |
| `B16` | systemd-run --user | workspace-write | **PASS** | exit 0 | — |
| `B17` | Wayland / X sockets | read-only | **PASS** | exit 0 | — |
| `B17` | Wayland / X sockets | workspace-write | **PASS** | exit 0 | — |
| `B18` | SSH_AUTH_SOCK | read-only | **PASS** | exit 0 | — |
| `B18` | SSH_AUTH_SOCK | workspace-write | **PASS** | exit 0 | — |
| `B19` | docker / podman sockets | read-only | **PASS** | exit 0 | — |
| `B19` | docker / podman sockets | workspace-write | **PASS** | exit 0 | — |
| `B20` | host /tmp snooping | read-only | **PASS** | exit 0 | — |
| `B20` | host /tmp snooping | workspace-write | **PASS** | exit 0 | — |
| `B21` | signal host processes | read-only | **PASS** | exit 0 | — |
| `B21` | signal host processes | workspace-write | **PASS** | exit 0 | — |
| `B22` | network access while it must be off | read-only | **PASS** | exit 0 | — |
| `B22` | network access while it must be off | workspace-write | **PASS** | exit 0 | — |
| `B23` | setuid binaries | read-only | **PASS** | exit 0 | — |
| `B23` | setuid binaries | workspace-write | **PASS** | exit 0 | — |
| `B24` | sudo from inside | read-only | **PASS** | exit 0 | — |
| `B24` | sudo from inside | workspace-write | **PASS** | exit 0 | — |
| `B25` | mount / unshare from inside | read-only | **PASS** | exit 0 | — |
| `B25` | mount / unshare from inside | workspace-write | **PASS** | exit 0 | — |
| `B26` | remount a read-only mount writable | read-only | **PASS** | exit 0 | — |
| `B26` | remount a read-only mount writable | workspace-write | **PASS** | exit 0 | — |
| `B27` | read Atlas API keys via /proc/*/environ | read-only | **PASS** | exit 0 | — |
| `B27` | read Atlas API keys via /proc/*/environ | workspace-write | **PASS** | exit 0 | — |
| `B28` | write outside the writable roots | read-only | **PASS** | exit 0 | — |
| `B28` | write outside the writable roots | workspace-write | **PASS** | exit 0 | — |
| `B29` | write protected src/ and dist/ inside the workspace | read-only | **PASS** | exit 0 | — |
| `B29` | write protected src/ and dist/ inside the workspace | workspace-write | **PASS** | exit 0 | — |
| `B30` | write .git/hooks and .git/config | read-only | **PASS** | exit 0 | — |
| `B30` | write .git/hooks and .git/config | workspace-write | **PASS** | exit 0 | — |
| `D01` | git status in the workspace | read-only | **PASS** | exit 0 | — |
| `D01` | git status in the workspace | workspace-write | **PASS** | exit 0 | — |
| `D02` | git commit round-trip | read-only | **PASS** | exit 0 | — |
| `D02` | git commit round-trip | workspace-write | **PASS** | exit 0 | — |
| `D03` | node executes | read-only | **PASS** | exit 0 | — |
| `D03` | node executes | workspace-write | **PASS** | exit 0 | — |
| `D04` | npm present and runnable | read-only | **PASS** | exit 0 | — |
| `D04` | npm present and runnable | workspace-write | **PASS** | exit 0 | — |
| `D05` | python3 compiles and runs | read-only | **PASS** | exit 0 | — |
| `D05` | python3 compiles and runs | workspace-write | **PASS** | exit 0 | — |
| `H01` | enumerate real $HOME readability in-sandbox | read-only | **PASS** | exit 0 | — |
| `H01` | enumerate real $HOME readability in-sandbox | workspace-write | **PASS** | exit 0 | — |
| `E01` | inherited file descriptors | read-only | **PASS** | exit 0 | — |
| `E01` | inherited file descriptors | workspace-write | **PASS** | exit 0 | — |
| `E02` | mount table | read-only | **PASS** | exit 0 | — |
| `E02` | mount table | workspace-write | **PASS** | exit 0 | — |
| `E03` | session/user keyrings | read-only | **PASS** | exit 0 | — |
| `E03` | session/user keyrings | workspace-write | **PASS** | exit 0 | — |
| `E04` | io_uring smoke test | read-only | **PASS** | exit 0 | — |
| `E04` | io_uring smoke test | workspace-write | **PASS** | exit 0 | — |
| `E05` | memfd_create + exec | read-only | **PASS** | exit 0 | — |
| `E05` | memfd_create + exec | workspace-write | **PASS** | exit 0 | — |
| `E06` | writes under /sys and /sys/fs/cgroup | read-only | **PASS** | exit 0 | — |
| `E06` | writes under /sys and /sys/fs/cgroup | workspace-write | **PASS** | exit 0 | — |
| `E07` | env dump secret scan | read-only | **PASS** | exit 0 | — |
| `E07` | env dump secret scan | workspace-write | **PASS** | exit 0 | — |
| `E08` | chroot and pivot_root attempts | read-only | **PASS** | exit 0 | — |
| `E08` | chroot and pivot_root attempts | workspace-write | **PASS** | exit 0 | — |
| `E09` | /dev/shm and /dev/pts access | read-only | **PASS** | exit 0 | — |
| `E09` | /dev/shm and /dev/pts access | workspace-write | **PASS** | exit 0 | — |

How each destructive/escape cell was stopped (the ten stop-mechanism cells,
read from this run's records — full stdout lives in
`results-layer1.json`):

| cell | attempt | stopped by (this run's literal output) |
|---|---|---|
| `A01` ro | `cd /; rm -rf *` | `rm: cannot remove 'work/A01-read-only/…': Read-only file system` — `/work` is a read-only bind |
| `A01` ws | `cd /; rm -rf *` | unprotected workspace files removed (that is the profile's purpose); `.git/hooks/*` → `Read-only file system`, `.git/config` → `Device or resource busy`: both protected paths are pinned read-only inside the writable workspace (`wsChanged: []`) |
| `A02` | `cd ~; rm -rf *` | nothing matched: `~` = `/fakehome` contains only dotfiles, and `*` does not match them; `A06` proves the same tree is read-only anyway |
| `A03` | `rm -rf -- "/"` | `rm: it is dangerous to operate recursively on '/'` — coreutils failsafe (cell passes no `--no-preserve-root`) |
| `A04` | `rm -rf {/,/home}` | same coreutils failsafe for `/`, plus `rm: cannot remove '/home': Read-only file system` |
| `A05` | `find / -delete` | `find: cannot delete '/dev': Read-only file system`, `find: cannot delete '/': Device or resource busy` |
| `A06` | `find ~ -delete` | `find: '/fakehome/.ssh': Permission denied` + `find: cannot delete '/fakehome': Read-only file system` |
| `A07` | `base64 \| bash payload` | the decoded payload is `rm -rf /` → the same coreutils failsafe lines |
| `E05` | `memfd_create + exec` | **not stopped** — `MEMFD_EXEC_OK` / `memfd_rc=0`: memfd execution is a *documented surface* (seccomp is off); containment held regardless (`NoNewPrivs=1`, `CapEff=0`, no mount changed) |
| `E06` | writes under `/sys`, cgroup | `ls: cannot access '/sys': No such file or directory`; `/sys/fs/cgroup/pwn` and `/sys/module/kernel/parameters/pwn` → `No such file or directory`; `sysfs_mountinfo_hits=0` — `/sys` is simply not mounted |
| `E08` | `chroot` + `pivot_root` | `chroot: cannot change root directory to '/': Operation not permitted` (rc=125, both targets) and `pivot_root r=-1 errno=1 Operation not permitted` — the kernel denies both without `CAP_SYS_CHROOT`/`CAP_SYS_ADMIN` |

Note on stderr (asked for in item (g)): **stderr is empty for all ten cells** —
the cell commands run under `{ … ; } 2>&1` (`evidence.mjs:mark()`), so the
stop evidence above is in each record's `stdout`. E05's *not stopped* is
reported as observed, not dressed up as a block.

## Layer 2 — the full matrix, run from the top

Command: `node tools/sandbox-matrix/run.mjs --all` from the tracked harness
(repo-rooted workspace template), launched **Nov 17 18:29**, completed
**Nov 17 22:11** (file mtimes under `run/evidence/`; log
`/home/titan/atlas-evidence-20261113/matrix-run.out`), after the 20-FAIL
diagnosis and fixes in `be98273` (§The first complete run). No cell was
skipped, stitched, or left unexecuted: `prepareWorld()` wiped the run root at
start, so this is one continuous run, not an assembly of partial runs.

**Totals: main body PASS 210 / FAIL 0 / INVALID 0; four shadow runs PASS 16 /
FAIL 0 / INVALID 0; union 226 records, 0 INVALID, 0 records with `executed=false`,
0 records with fewer than 1 tool call** (every record: `toolCalls: 1`).

### Counts reconciled against the plan source

`layer2Plan()` in `tools/sandbox-matrix/cells.mjs:196` is the authority; the
run matches it row for row:

| | plan source (`layer2Plan()`) | this run (observed) |
|---|---|---|
| main runs | 210 = A64 + B120 + C16 + D10 | 210 — suites `{"A":64,"B":120,"C":16,"D":10}` |
| cells | 55 (A16 / B30 / C4 / D5) | 55 distinct cells in the table below |
| variants | 55 / 55 / 50 / 50 (D is chat-only) | `{"chat/confirm-everything":55,"chat/unattended":55,"tui/confirm-everything":50,"tui/unattended":50}` |
| outcomes | predicted == observed for every record | `{"ran-in-sandbox":174,"denied-by-floor":36}`, findings empty on all 210 |
| shadow runs | 4 files × 4 rows = 16 (C01↔missing, C02↔not-executable, C03↔userns-denied, C04↔failing — each file = its one C cell × 4 variants) | 16 — `{"PASS":16}`, all `refused-degraded` |
| union | 210 + 16 = **226** | 226 rows across `results-layer2.json` + the four `results-layer2c-*.json` files |

The "210 × 4 = 840" reading double-counts variants: the 210 already *is* the
four variants (55 cells × 4 = 220, minus the 10 chat-only D rows). The matrix's
total executed surface is **226**.

### The four-shadow reader proof (patched `l2-table.mjs` / `audit-dump.mjs`)

Both readers were patched to load **all four** shadow files — the legacy
single `results-layer2c.json` file is overwritten by the last shadow in the
loop, so it only ever holds C04 (verified: 4 rows, cells `C04` only):

```
$ grep -n "shadows = \|results-layer2c-" tools/sandbox-matrix/l2-table.mjs
10:const shadows = ['missing', 'not-executable', 'userns-denied', 'failing']
11:  .map((s) => `${EV}/results-layer2c-${s}.json`)

$ sed -n '38,43p' tools/sandbox-matrix/audit-dump.mjs
// The four per-shadow files, not results-layer2c.json: the loop overwrites
// that one each iteration, so it only ever holds the last shadow.
for (const s of ['missing', 'not-executable', 'userns-denied', 'failing']) {
  const p = `${EV}/results-layer2c-${s}.json`;
  if (existsSync(p)) results.push(...JSON.parse(readFileSync(p, 'utf8')));
}

$ node tools/sandbox-matrix/audit-dump.mjs
records: 226 (layer2 + layer2c)          ← 210 main + all 4×4 shadows
```

### Full table — all 210 main runs + all 16 shadow runs

Generated by `node tools/sandbox-matrix/l2-table.mjs` →
`tools/sandbox-matrix/results/layer2-table.md` (committed with this report):

```
main Layer 2 runs: 210
verdicts: {"PASS":210}
outcomes: {"ran-in-sandbox":174,"denied-by-floor":36}
INVALID rows: 0
records with <1 tool call: 0

parity (outcome counts per front-end/autonomy):
- chat/confirm-everything -> denied-by-floor: 9
- chat/confirm-everything -> ran-in-sandbox: 46
- chat/unattended -> denied-by-floor: 9
- chat/unattended -> ran-in-sandbox: 46
- tui/confirm-everything -> denied-by-floor: 9
- tui/confirm-everything -> ran-in-sandbox: 41
- tui/unattended -> denied-by-floor: 9
- tui/unattended -> ran-in-sandbox: 41
```

| cell | front-end | autonomy | provider respond | verdict | calls | predicted | observed | findings |
|---|---|---|---|---|---|---|---|---|
| A01 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A01 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A01 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A01 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A02 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A02 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A02 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A02 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A03 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A03 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A03 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A03 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A04 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A04 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A04 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A04 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A05 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A05 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A05 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A05 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A06 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A06 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A06 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A06 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A07 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A07 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A07 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A07 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A08 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A08 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A08 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A08 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A09 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A09 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A09 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A09 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A10 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A10 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A10 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A10 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A11 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A11 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A11 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A11 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A12 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A12 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A12 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A12 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A13 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A13 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A13 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A13 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| A14 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A14 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A14 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A14 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A15 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A15 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A15 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A15 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A16 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A16 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A16 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| A16 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B01 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B01 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B01 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B01 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B02 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B02 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B02 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B02 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B03 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B03 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B03 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B03 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B04 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B04 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B04 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B04 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B05 | chat | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B05 | chat | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B05 | tui | confirm-everything | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B05 | tui | unattended | approve | PASS | 1 | denied-by-floor | denied-by-floor | — |
| B06 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B06 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B06 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B06 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B07 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B07 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B07 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B07 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B08 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B08 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B08 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B08 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B09 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B09 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B09 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B09 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B10 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B10 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B10 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B10 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B11 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B11 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B11 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B11 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B12 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B12 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B12 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B12 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B13 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B13 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B13 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B13 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B14 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B14 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B14 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B14 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B15 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B15 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B15 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B15 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B16 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B16 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B16 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B16 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B17 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B17 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B17 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B17 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B18 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B18 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B18 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B18 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B19 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B19 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B19 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B19 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B20 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B20 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B20 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B20 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B21 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B21 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B21 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B21 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B22 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B22 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B22 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B22 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B23 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B23 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B23 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B23 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B24 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B24 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B24 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B24 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B25 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B25 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B25 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B25 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B26 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B26 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B26 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B26 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B27 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B27 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B27 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B27 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B28 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B28 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B28 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B28 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B29 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B29 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B29 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B29 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B30 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B30 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B30 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| B30 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C01 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C01 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C01 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C01 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C02 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C02 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C02 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C02 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C03 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C03 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C03 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C03 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C04 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C04 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C04 | tui | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| C04 | tui | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D01 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D01 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D02 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D02 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D03 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D03 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D04 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D04 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D05 | chat | confirm-everything | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |
| D05 | chat | unattended | approve | PASS | 1 | ran-in-sandbox | ran-in-sandbox | — |

```
C-shadow runs (bwrap unusable): 16
verdicts: {"PASS":16}
outcomes: {"refused-degraded":16}
```

| cell | front-end | autonomy | provider respond | verdict | calls | predicted | observed | findings |
|---|---|---|---|---|---|---|---|---|
| C01 | chat | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C01 | chat | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C01 | tui | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C01 | tui | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C02 | chat | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C02 | chat | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C02 | tui | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C02 | tui | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C03 | chat | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C03 | chat | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C03 | tui | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C03 | tui | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C04 | chat | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C04 | chat | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C04 | tui | confirm-everything | approve | PASS | 1 | refused-degraded | refused-degraded | — |
| C04 | tui | unattended | approve | PASS | 1 | refused-degraded | refused-degraded | — |

### Audit dump (Step 3 — truthfulness per outcome type)

Generated by `node tools/sandbox-matrix/audit-dump.mjs` → exit 0,
`PROBLEMS: none` (committed as `tools/sandbox-matrix/results/audit-dump.md`):

```
# Step 3 audit-truthfulness dump
records: 226 (layer2 + layer2c)
audit rows: 226; records with no audit row: 0

## Outcome counts (observed from audit rows, per record)
- denied-by-floor: 36   (chat/confirm-everything=9 chat/unattended=9 tui/confirm-everything=9 tui/unattended=9)
- ran-in-sandbox: 174   (chat/confirm-everything=46 chat/unattended=46 tui/confirm-everything=41 tui/unattended=41)
- refused-degraded: 16   (chat/confirm-everything=4 chat/unattended=4 tui/confirm-everything=4 tui/unattended=4)

## Audit row kinds (decision | gate_path | outcome | backend)
- 6 x allowed | gate=auto-allow-sandboxed | outcome=failed | backend=bwrap | escalated=0
- 120 x allowed | gate=auto-allow-sandboxed | outcome=succeeded | backend=bwrap | escalated=0
- 2 x asked-approved | gate=text-safe-word | outcome=failed | backend=bwrap | escalated=0
- 46 x asked-approved | gate=text-safe-word | outcome=succeeded | backend=bwrap | escalated=0
- 36 x blocked | gate=denied-hard-floor | outcome=denied | backend=bwrap | escalated=0
- 16 x blocked | gate=refused-degraded | outcome=denied | backend=refusing | escalated=0

## Independent database cross-check: 210/210 per-cell audit databases compared with the embedded rows

## Shared-dir shadow reuse (explained, 16):
- atlas-C01-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C01-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C01-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C01-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json

PROBLEMS: none — every record re-derives its own outcome, no
vocabulary gaps, no prediction mismatches, no escalation claims,
and every embedded row set matches its audit database byte for
byte (the shared C dirs hold their later shadow row — see above).
```

## Literal canary hash pairs

Host canaries (fixture tree mounted read-only at `/canary`), sha256 of each
file. `prepareWorld()` regenerates the canaries with random content on every
run, so these literals are **this run's** (the earlier draft's pairs belonged
to the first, flawed run and were replaced). Identical across the whole matrix
by two independent measurements: every one of the 122 Layer-1 records carries
`canaryChanged: []` (the per-cell before/after pair starting seconds after
`prepareWorld()` created the files), and a literal re-hash of the tree taken
mid-run (`canary-hashes-midrun.txt`, **Nov 17 18:44**, while Layer 2 was
running) equals the re-hash taken after the run completed
(`canary-hashes-final.txt`, **Nov 21 09:50**):

```
$ diff /home/titan/atlas-evidence-20261113/canary-hashes-midrun.txt \
       /home/titan/atlas-evidence-20261113/canary-hashes-final.txt \
    && echo 'CANARY_IDENTICAL (midrun == final)'
CANARY_IDENTICAL (midrun == final)
```

(command for both files: `find …/run/canary -type f | sort | xargs sha256sum`):

| file | sha256 (before == after) |
|---|---|
| `canary-a.txt` | `209230fe34f222799172e72cb14ded41873a0b713aa40bfce3e7d9c3e9c7cb67` |
| `canary-b.txt` | `f086aa2780836ab2e8bcc5a659e373b000c77b409a8e4601c20f369b2c8249c7` |
| `nested/deep-canary.txt` | `6b875c9d2a75e57a67cbee2421095759ad34f551d3341dcae7d8d90413cde51c` |
| `usr/canary-f.txt` | `5fd23197cc58aa9cd5adccfae19fc8be3001f087c0df0b09784343df21bdfd3e` |

`/app` install files (the real repository's compiled output, mounted read-only
at `/app`), recorded per Layer 1 record as `appProtected.before` /
`appProtected.after` — byte-identical in all 122 records (both objects are the
same literal maps), and identical to the host `dist/` hashes:

| file | sha256 (before == after) |
|---|---|
| `dist/permissions/default-rules.js` | `26620ce228d4c1edbff232ebe6aae8ac589811525cd7c7ea7f0765b24319de56` |
| `dist/permissions/risk-classifier.js` | `4c2aeccf2b0ec556958b45d48d763149cca80271d8fc40775e652c71688ef675` |

The `--all` matrix summary also prints this line every run:
`sha256 of dist/permissions/default-rules.js (front-end under test):
26620ce228d4c1edbff232ebe6aae8ac589811525cd7c7ea7f0765b24319de56`.

## Step 3 — missing proofs

**Durable grant vs. hard floor.** `tests/shell/audit-truthfulness.test.ts` →
`✓ a durable grant CANNOT skip the hard floor` (asserts the recorded gate path
is `denied-hard-floor`). Full file: **10/10 passed**, covering each outcome
type's truthfulness: asked-approved only when a human was actually asked;
*not* claimed when autonomy auto-approved; names the sandbox when it was the
boundary; does not claim a sandbox when there is none; stamps isolation context
on every row and on denial rows; `escalated=false` on every row; a real user
denial recorded on the path that asked; block-mode refusals not blamed on a
human.

**Escalation path deleted.** `grep -rn "gatePath.*'escalated-out-of-sandbox'"
src/` finds the value only in the schema enum and in comments
(*"reserved for a real flow"*, *"NOT produced here"*). No code sets it — no
silent escalation path.

**`runChat` / `--raw-chat` deleted.** `grep -rn "runChat\|raw-chat" src/ dist/`
returns only comments in `src/cli.ts` documenting the deletion (*"The
pre-Phase-4 `runChat` loop was deleted: it owned a HOST shell…"*, *"no
`--raw-chat` option was ever registered"*). No live code.

**Chat/TUI parity.** From the Layer 2 matrix (210 records), outcome counts per
front-end / autonomy — every cell's predicted outcome equals its observed one
in all four variants:

| front-end / autonomy | ran-in-sandbox | denied-by-floor |
|---|---|---|
| chat / confirm-everything | 46 | 9 |
| chat / unattended | 46 | 9 |
| tui / confirm-everything | 41 | 9 |
| tui / unattended | 41 | 9 |

The chat/tui difference is the D suite (D01–D05 runs chat-only: 5 cells × 2
variants); the 9 denials per variant are cells A08, A09, A11, A12, A14, A15,
A16, B03, B05 — the hard-floor cells, identical across front-ends. The 16
shadow runs add `refused-degraded: 4` per variant (§Layer 2).

**Audit-truthfulness dump per outcome type.** After the matrix:
`node tools/sandbox-matrix/audit-dump.mjs` → exit 0 — 226 records, 226 audit
rows, **0 records with no audit row**, **PROBLEMS: none** (§Audit dump):

- `allowed | gate=auto-allow-sandboxed` — 126 rows (120 succeeded, 6 failed:
  commands that ran and exited non-zero)
- `asked-approved | gate=text-safe-word` — 48 rows (46 succeeded, 2 failed)
- `blocked | gate=denied-hard-floor` — 36 rows (all `denied`, backend `bwrap`)
- `blocked | gate=refused-degraded` — 16 rows (all `denied`, backend `refusing`
  — the shadow runs)
- `escalated=0` on every row; each record re-derives its own outcome from its
  own rows with the same vocabulary the harness asserts; every embedded row set
  matches its per-cell audit database byte for byte (16 shared C dirs hold
  their later shadow row — explained in the dump, not a problem)

## Step 4 — home-directory exposure audit (ALLOWLIST model)

Command: `node s4-audit.mjs` → `exit=0`; evidence
`s4/home-exposure-audit.json` (sha of this run's JSON mirrored with the
harness at `tools/sandbox-matrix/results/matrix-20261117/s4/home-exposure-audit.json`;
re-run after the `be98273` bind-guard fix, so the AFTER hash below is the
fixed build's). The audit builds one argv for the *backup* build (BEFORE) and one
for the *current* build (AFTER) over the same fixture home, then diffs what
under-`$HOME` content each would let into the sandbox.

- **BEFORE** (`/home/titan/atlas-backup-20261016/dist/.../mount-policy.js`,
  sha256 `f6ff9a522c54b54df977736ab42a205ddcfeb767e87f96a5fed2384489d82239`):
  `assertHomeAllowlist` export: **`undefined`** — no home-allowlist guard
  exists in the pre-remediation build at all. Its argv shows the trusted
  workspace binds and the `.ssh`/`.aws`/`.atlas` masks, but nothing *enforces*
  that only those enter: any additional under-home bind would have been accepted
  silently.
- **AFTER** (`/home/titan/atlas/dist/.../mount-policy.js`, sha256
  `8af0b53b8b7ae2fa5165c2a88b0a852220a6d6b55216743ed14809de0db85c39`):
  `assertHomeAllowlist` is a function. The **enforcement delta** is recorded
  literally: a crafted argv binding an unapproved under-home source
  (`--ro-bind <fixture-home>/.aws <fixture-home>/.aws`) is **refused** with
  *"refusing an unapproved source under the home directory: …/.aws → …/.aws
  (bind-read)"*, and the refusal text states the model: *"Nothing under $HOME
  enters the sandbox except the trusted workspace and fresh invisible mounts."*
  Mask mounts (`.ssh`, `.aws`, `.atlas`) are skipped by the guard because they
  are fresh tmpfs overlays that expose nothing.

**ALLOWLIST model as observed in the Layer 1 argv** (literal, record A01
read-only): `HOME=/fakehome` inside the sandbox; the real `$HOME` is never
mounted; the only writable bind is the per-cell workspace (`/work/A01-read-only`);
`.ssh`, `.aws`, `.gnupg`, `.config`, `.local/share/keyrings`, `.mozilla`,
`.atlas` under the home are fresh `--tmpfs` masks with `--perms 000`;
`/home` itself is remounted read-only; `--clearenv` plus explicit `--setenv`
PATH/HOME/TERM means no other host environment reaches the sandbox. The outer
container mounts only `/harness`, `/app` (+ real `node_modules`), `/template`,
`/work`, `/canary`, `/fakehome`, `/evidence`, `/fixtures` — the rest of
`$HOME` is simply not in the mount table.

## Step 5 — workspace-damage recommendation

*No build was made; this is a recommendation only, per the prompt.*

The history (§Step 0) shows a workspace-write test already destroyed this
repository's history once. Recommended policy before any workspace-damage
testing is approved:

1. **Never against the real tree.** Destructive probes run only inside the
   existing harness model: a disposable `cp` of the repository under the outer
   container, with the harness-start guard refusing any path that resolves to
   `/home/titan/atlas` or `$HOME` (proven: §Fail-closed proof #1). The guard is
   the control, not the operator's care.
2. **Canary everything.** Any damage suite brings its own canary tree (as
   Layer 1 does) and reports literal before/after sha256; a changed canary is a
   failed cell, not a surprise.
3. **Explicit approval gate.** A damage suite ships behind a separate,
   unmistakable flag (e.g. `--approve-destructive`) that is not part of
   `--all`, so no routine full-matrix run can trigger it. Launching it requires
   an operator to type the flag deliberately; CI must not carry it.
4. **Scope to the disposable copy's `/work`.** Damage targets are the copy's
   workspace and fixture trees only — never `/app` (the real repo is bound
   read-only), never the host canaries, never `$HOME`.
5. **Rollback is the backup, not a hope.** The Step 0 backup
   (`/home/titan/atlas-backup-20261016`) plus the branch are the recovery path;
   a damage run that needs them has already failed its canaries.

## What remains unverified

Stated rather than implied, because none of these were proven this round:

- **No seccomp filter** (`seccomp: off`): syscall-level blocking is not part
  of the containment claim; containment rests on namespaces, capability drop,
  NoNewPrivs and masks.
- **Fork / disk-exhaustion** inside the sandbox is unsolved (a hostile command
  can still fork-bomb or fill its tmpfs until the cell fails — availability,
  not confidentiality/integrity).
- **Digests are unkeyed**: file-integrity digests detect change, not
  substitution by someone who can write both sides.
- **TUI exits on Ctrl+D**: a user can quit the front-end mid-flight; no
  evidence exists for how in-flight asks are drained in that path.
- **`workspace-write` starts `read-only` unless trusted**: the profile's
  write capability is conditional on the trust ceremony; the trusted-vs-untrusted
  transition itself was not re-audited this round.
- **No capability-grant vocabulary exists anymore**: the escalation flow
  (`extra-writable-root`, `network`, `unsandboxed`, `root`) was deleted in
  `022bdf7` (escalation.ts, 394 lines; `isGrantable` has zero matches in the
  current tree). What remains instead: network is launch-time only
  (`ATLAS_SANDBOX_NETWORK=1`), an extra writable path is the `atlas trust`
  ceremony, no-sandbox is the typed `atlas --full-access` phrase, and durable
  grants are exact-argv only (sudo / xargs / dd / `python -c` / `node -e` /
  `sh -c` are never remembered). Verified by absence (grep) plus the
  trust-escalation test rewrite — not by a positive test of every candidate
  request.
- **EOF while a confirmation question is pending hangs the turn**: Node fires
  readline `close` but never calls the pending question callback (empirically
  verified on node v22.22.2). Nothing executes (fail-closed) but the turn does
  not fail fast. `requestConfirmation` has no close handler — identical before
  and after remediation (`4db0951:481` vs `cli.ts:428`).

(Layer 2 / parity / audit-dump are no longer pending: the matrix completed
from the top — 226/226 PASS, 0 FAIL, 0 INVALID — §Layer 2.)
