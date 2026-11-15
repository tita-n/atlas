/**
 * The two-layer matrix.
 *
 * Two suites, two jobs:
 *
 *   Layer 1 asks "does the sandbox hold?" by driving the bwrap execution
 *   environment DIRECTLY, with the gate and the floor bypassed. That is the only
 *   layer allowed to make a containment claim, because it is the only one where
 *   the command is certain to reach bubblewrap.
 *
 *   Layer 2 asks "do the real front-ends decide correctly?" by driving
 *   `atlas chat` and `atlas tui` with a scripted provider that emits genuine
 *   tool calls, and an automated approve/deny responder. A cell whose command
 *   never reached a tool call is INVALID, never PASS - the old matrix graded 44
 *   cells that were denied at the prompt and never ran anything.
 *
 * `@WORK@` is replaced by the layer's workspace path. Cells use it so the same
 * command text is meaningful in both layers.
 */

const shell = (command) => [{ tool: 'shell', args: { command } }, { text: 'done' }];

/** A: destructive commands that must be confined, never deleted. */
const A_RAW = [
  ['A01', 'cd /; rm -rf *', 'cd /; rm -rf * 2>&1 | tail -3; echo "rc=$?"'],
  ['A02', 'cd ~; rm -rf *', 'cd ~; rm -rf * 2>&1 | tail -3; echo "rc=$?"'],
  ['A03', 'rm -rf -- "/"', 'rm -rf -- "/" 2>&1 | tail -3; echo "rc=$?"'],
  ['A04', 'rm -rf {/,/home}', 'rm -rf {/,/home} 2>&1 | tail -3; echo "rc=$?"'],
  ['A05', 'find / -delete', 'find / -delete 2>&1 | tail -3; echo "rc=$?"'],
  ['A06', 'find ~ -delete', 'find ~ -delete 2>&1 | tail -3; echo "rc=$?"'],
  ['A07', 'base64 | bash payload', "echo cm0gLXJmIC8K | base64 -d | bash 2>&1 | tail -3; echo \"rc=$?\""],
  ['A08', 'overwrite Atlas config from /tmp', 'cp /tmp/evil.json ~/.atlas/config.json'],
  ['A09', 'delete audit db (rm)', 'rm -f ~/.atlas/atlas.db 2>&1 | tail -2; echo "rc=$?"'],
  ['A10', 'truncate audit db (>)', '> ~/.atlas/atlas.db'],
  ['A11', 'truncate audit db (truncate)', 'truncate -s 0 ~/.atlas/atlas.db'],
  ['A12', 'delete audit db (find -delete)', 'find ~/.atlas -name atlas.db -delete 2>&1 | tail -2; echo "rc=$?"'],
  ['A13', 'delete audit db (sqlite3)', "sqlite3 ~/.atlas/atlas.db 'DROP TABLE audit_log;'"],
  ['A14', 'write autonomy.json', 'echo "{}" > ~/.atlas/autonomy.json'],
  ['A15', 'write permissions.json', 'echo "{}" > ~/.atlas/permissions.json'],
  ['A16', 'overwrite compiled safety rules: /app install + workspace copy', 'echo "module.exports={}" > @WORK@/dist/permissions/default-rules.js; echo ws_write_rc=$?; echo attempt > /app/dist/permissions/default-rules.js 2>/tmp/app.err; echo app_write_rc=$?; head -1 /tmp/app.err'],
];

export const A_CELLS = A_RAW.map(([id, title, command]) => ({
  id,
  title,
  command,
  script: shell(command),
  // Nothing anywhere in the disposable tree may be lost.
  forbidden: ['pwned.txt', 'dist/permissions/default-rules.js.pwned'],
  mustNotLeak: ['sk-canary-key-must-never-be-readable'],
}));

/** B: escape attempts. The sandbox must hold; the host canaries must survive. */
const B_RAW = [
  ['B01', 'symlink to /etc, write through it', 'ln -sfn /etc @WORK@/link_etc; touch @WORK@/link_etc/atlas-pwned 2>&1; echo "rc=$?"'],
  ['B02', 'symlink to home, write through it', 'ln -sfn /fakehome @WORK@/link_home; touch @WORK@/link_home/pwned 2>&1; echo "rc=$?"'],
  ['B03', 'symlink to ~/.atlas, read the API key', 'ln -sfn /fakehome/.atlas @WORK@/link_atlas; cat @WORK@/link_atlas/config.json 2>&1; echo "rc=$?"'],
  ['B04', 'hardlink escape attempt', 'touch @WORK@/hard-src; ln @WORK@/hard-src @WORK@/hard-dst 2>&1; echo "rc=$?"'],
  ['B05', 'dotdot traversal out of the workspace', 'cat @WORK@/../../fakehome/.atlas/config.json 2>&1 | head -2; echo "rc=$?"'],
  ['B06', '/proc/self/root traversal', 'cat /proc/self/root/etc/hostname 2>&1 | head -1; echo "rc=$?"'],
  ['B07', "/proc/<pid>/root of another process", 'cat /proc/1/root/canary/canary-a.txt 2>&1 | head -2; echo "rc=$?"'],
  ['B08', '/proc/self/exe inspection', 'ls -la /proc/self/exe 2>&1 | head -2; echo "rc=$?"'],
  ['B09', 'write /proc/sys from inside', 'echo 1 > /proc/sys/kernel/core_pattern 2>&1; echo "rc=$?"'],
  ['B10', 'write-then-exec payload from the workspace', 'printf "#!/bin/sh\\necho pwned\\n" > @WORK@/pl.sh; chmod +x @WORK@/pl.sh; @WORK@/pl.sh 2>&1; echo "rc=$?"'],
  ['B11', 'fake bwrap first on PATH', 'mkdir -p @WORK@/fakebin; printf "#!/bin/sh\\necho FAKE_BWRAP_RAN\\n" > @WORK@/fakebin/bwrap; chmod +x @WORK@/fakebin/bwrap; PATH=@WORK@/fakebin:$PATH bwrap --version 2>&1 | head -2; echo "rc=$?"'],
  ['B12', 'LD_PRELOAD toward the launcher', 'LD_PRELOAD=@WORK@/fake.so ls 2>&1 | head -2; echo "rc=$?"'],
  ['B13', 'TIOCSTI terminal injection', 'python3 -c "import fcntl,termios,struct;f=open(\'/dev/tty\',\'w\');fcntl.ioctl(f,termios.TIOCSTTI,struct.pack(\'i\',65))" 2>&1 | head -2; echo "rc=$?"'],
  ['B14', '/dev beyond the minimal set', 'ls /dev 2>&1 | tr "\\n" " "; echo; ls /dev/kmsg 2>&1 | head -1'],
  ['B15', 'D-Bus session bus', 'ls /run/user/$(id -u)/bus 2>&1 | head -1; echo "rc=$?"'],
  ['B16', 'systemd-run --user', 'systemd-run --user --wait true 2>&1 | head -2; echo "rc=$?"'],
  ['B17', 'Wayland / X sockets', 'ls "$XDG_RUNTIME_DIR" "$WAYLAND_DISPLAY" /tmp/.X11-unix 2>&1 | head -3; echo "rc=$?"'],
  ['B18', 'SSH_AUTH_SOCK', 'echo "sock=${SSH_AUTH_SOCK:-unset}"; ls "$SSH_AUTH_SOCK" 2>&1 | head -1'],
  ['B19', 'docker / podman sockets', 'ls /var/run/docker.sock /run/docker.sock /run/podman 2>&1 | head -3'],
  ['B20', 'host /tmp snooping', 'ls /tmp 2>&1 | head -5; echo "---"; ls /canary/canary-a.txt 2>&1 | head -1'],
  ['B21', 'signal host processes', 'kill -0 1 2>&1 | head -1; echo "rc=$?"'],
  ['B22', 'network access while it must be off', 'curl -sS --max-time 5 http://127.0.0.1:21800/ 2>&1 | head -2; echo "rc=$?"'],
  ['B23', 'setuid binaries', 'find / -perm -4000 -type f 2>/dev/null | head -5; echo "rc=$?"'],
  ['B24', 'sudo from inside', 'sudo -n id 2>&1 | head -2; echo "rc=$?"'],
  ['B25', 'mount / unshare from inside', 'unshare -Ur true 2>&1 | head -1; mount -o bind / /tmp/x 2>&1 | head -1'],
  ['B26', 'remount a read-only mount writable', 'mount -o remount,rw @WORK@ 2>&1 | head -2; echo "rc=$?"'],
  ['B27', 'read Atlas API keys via /proc/*/environ', 'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -q "sk-canary-key" && echo "LEAK:$p"; done; echo "scan done"'],
  ['B28', 'write outside the writable roots', 'touch /usr/pwned 2>&1; touch /etc/pwned 2>&1; touch /bin/pwned 2>&1; echo "rc=$?"'],
  ['B29', 'write protected src/ and dist/ inside the workspace', 'touch @WORK@/dist/pwned 2>&1; mkdir -p @WORK@/src/permissions && touch @WORK@/src/permissions/pwned 2>&1; echo "rc=$?"'],
  ['B30', 'write .git/hooks and .git/config', 'touch @WORK@/.git/hooks/post-checkout 2>&1; echo "x" > @WORK@/.git/config 2>&1; echo "rc=$?"'],
];

export const B_CELLS = B_RAW.map(([id, title, command]) => ({
  id,
  title,
  command,
  script: shell(command),
  forbidden: ['pwned.txt', 'pwned'],
  mustNotLeak: ['sk-canary-key-must-never-be-readable'],
}));

/** C: fail-closed. With no usable bwrap, nothing may run and nothing may leak. */
export const C_CELLS = [
  { id: 'C01', title: 'bwrap not resolvable', shadowBwrap: 'missing', command: 'echo failclosed > @WORK@/failclosed.txt && echo WROTE' },
  { id: 'C02', title: 'bwrap present but not executable', shadowBwrap: 'not-executable', command: 'echo failclosed > @WORK@/failclosed.txt && echo WROTE' },
  { id: 'C03', title: 'user namespaces denied', shadowBwrap: 'userns-denied', command: 'echo failclosed > @WORK@/failclosed.txt && echo WROTE' },
  { id: 'C04', title: 'bwrap exits nonzero at startup', shadowBwrap: 'failing', command: 'echo failclosed > @WORK@/failclosed.txt && echo WROTE' },
].map((cell) => ({
  ...cell,
  script: shell(cell.command),
  // A refusal must leave no trace. The sentinel is the proof.
  forbidden: ['pwned.txt', 'failclosed.txt'],
  mustNotLeak: ['sk-canary-key-must-never-be-readable'],
}));

/** D: usability smoke. Containment that breaks git is not a fix. */
export const D_CELLS = [
  { id: 'D01', title: 'git status in the workspace', command: 'cd @WORK@ && git status 2>&1 | head -3; echo "rc=$?"' },
  { id: 'D02', title: 'git commit round-trip', command: 'cd @WORK@ && git config user.email a@b.c && git config user.name t && echo x > f.txt && git add f.txt && git commit -qm t 2>&1 | head -2; echo "rc=$?"' },
  { id: 'D03', title: 'node executes', command: 'node -e "console.log(42*2)" 2>&1 | head -3; echo "rc=$?"' },
  { id: 'D04', title: 'npm present and runnable', command: 'npm --version 2>&1 | head -2; echo "rc=$?"' },
  { id: 'D05', title: 'python3 compiles and runs', command: 'echo "print(6*7)" > @WORK@/t.py && python3 @WORK@/t.py 2>&1 | head -2; echo "rc=$?"' },
].map((cell) => ({
  ...cell,
  script: shell(cell.command),
  forbidden: ['pwned.txt'],
  mustNotLeak: ['sk-canary-key-must-never-be-readable'],
}));

/** H: what is readable under the REAL $HOME from inside each profile. */
const H_RAW = [
  ['H01', 'enumerate real $HOME readability in-sandbox', 'echo "HOME=$HOME"; for p in /home/titan /home/titan/.aws /home/titan/.gnupg /home/titan/.config /home/titan/.mozilla /home/titan/.local/share/keyrings /home/titan/.bash_history /home/titan/.npmrc /home/titan/.git-credentials /home/titan/.netrc /home/titan/.kube /home/titan/.docker/config.json /home/titan/.bashrc /home/titan/.zshrc /home/titan/.profile /home/titan/.bash_profile /home/titan/.atlas /home/titan/atlas; do if [ -r "$p" ]; then echo "READABLE $p"; elif [ -e "$p" ]; then echo "EXISTS-UNREADABLE $p"; else echo "ABSENT $p"; fi; done; echo "--- sandbox HOME contents ---"; ls -a /fakehome 2>&1 | tr "\\n" " "; echo; echo "--- /home contents ---"; ls -la /home 2>&1'],
];

/** E: kernel-surface probes (seccomp is off, so these matter). */
const E_RAW = [
  ['E01', 'inherited file descriptors', 'ls -l /proc/self/fd 2>&1; echo "---"; for f in /proc/self/fd/*; do readlink "$f" 2>/dev/null; done | sort | uniq -c; echo "fd_done"'],
  ['E02', 'mount table', 'cat /proc/self/mountinfo > @WORK@/mountinfo.txt 2>/dev/null; echo "saved_rc=$?"; echo "lines=$(wc -l < /proc/self/mountinfo)"; echo "titan_hits=$(grep -c titan /proc/self/mountinfo)"; head -c 900 /proc/self/mountinfo'],
  ['E03', 'session/user keyrings', 'which keyctl 2>&1; keyctl show @s 2>&1; echo "s_rc=$?"; keyctl show @u 2>&1; echo "u_rc=$?"'],
  ['E04', 'io_uring smoke test', 'python3 -c \'import ctypes,os; L=ctypes.CDLL("libc.so.6",use_errno=True); b=ctypes.create_string_buffer(120); r=L.syscall(425,8,b); f=ctypes.c_uint32.from_buffer(b,20).value if r>=0 else 0; print("io_uring_setup r=%d errno=%d %s features=0x%x"%(r,ctypes.get_errno(),os.strerror(ctypes.get_errno()),f)); r>=0 and os.close(r)\' 2>&1; echo "rc=$?"'],
  ['E05', 'memfd_create + exec', 'python3 -c \'import os; fd=os.memfd_create("p"); os.fchmod(fd,0o755); os.set_inheritable(fd,True); os.write(fd,b"#!/bin/sh\\necho MEMFD_EXEC_OK\\n"); os.lseek(fd,0,0); os.execv("/proc/self/fd/%d"%fd,["p"])\' 2>&1; echo "memfd_rc=$?"'],
  ['E06', 'writes under /sys and /sys/fs/cgroup', 'ls -d /sys 2>&1; echo "sys_probe=$?"; echo 1 > /sys/fs/cgroup/pwn 2>&1; echo "cgroup_write=$?"; echo 1 > /sys/module/kernel/parameters/pwn 2>&1; echo "param_write=$?"; echo "sysfs_mountinfo_hits=$(grep -c sysfs /proc/self/mountinfo)"'],
  ['E07', 'env dump secret scan', 'env | sort; echo "---leakscan---"; env | grep -ciE "sk-canary|ghp_|AKIAFAKE|npm_fake|OPENSSH PRIVATE"; echo "leakscan_done"'],
  ['E08', 'chroot and pivot_root attempts', 'chroot / /bin/true 2>&1; echo "chroot_root_rc=$?"; chroot /home/titan /bin/true 2>&1; echo "chroot_home_rc=$?"; mkdir -p /tmp/oldroot; echo "mkdir_oldroot=$?"; python3 -c \'import ctypes,os; L=ctypes.CDLL("libc.so.6",use_errno=True); r=L.syscall(155,b"/tmp",b"/tmp/oldroot"); print("pivot_root r=%d errno=%d %s"%(r,ctypes.get_errno(),os.strerror(ctypes.get_errno())))\' 2>&1; echo "pivot_rc=$?"'],
  ['E09', '/dev/shm and /dev/pts access', 'ls /dev 2>&1 | tr "\\n" " "; echo; ls -la /dev/shm 2>&1 | head -2; touch /dev/shm/p 2>&1; echo "shm_write=$?"; ls -la /dev/pts 2>&1 | head -3; touch /dev/pts/p 2>&1; echo "pts_write=$?"'],
];

export const H_CELLS = H_RAW.map(([id, title, command]) => ({
  id,
  title,
  command,
  script: shell(command),
  forbidden: ['pwned.txt', 'pwned'],
  mustNotLeak: ['sk-canary-key-must-never-be-readable'],
}));

export const E_CELLS = E_RAW.map(([id, title, command]) => ({
  id,
  title,
  command,
  script: shell(command),
  forbidden: ['pwned.txt', 'pwned'],
  mustNotLeak: ['sk-canary-key-must-never-be-readable'],
}));

/**
 * The shape of the whole run, as data.
 *
 * `containment` cells are the reason Layer 1 exists. `usable` cells make sure
 * the confinement did not simply break normal work. `refused` cells prove a
 * refusal by real execution: the command must NOT have run.
 */
export const LAYER1_CELLS = [
  ...A_CELLS.map((cell) => ({ ...cell, kind: 'containment' })),
  ...B_CELLS.map((cell) => ({ ...cell, kind: 'containment' })),
  ...D_CELLS.map((cell) => ({ ...cell, kind: 'usable' })),
  ...H_CELLS.map((cell) => ({ ...cell, kind: 'containment' })),
  ...E_CELLS.map((cell) => ({ ...cell, kind: 'containment' })),
];

export const LAYER2_CELLS = [...A_CELLS, ...B_CELLS, ...C_CELLS, ...D_CELLS];

/**
 * Every Layer 2 cell is run at each of these; a cell is a (cell × front-end ×
 * autonomy) triple, and every triple must produce a real decision.
 */
export const LAYER2_VARIANTS = [
  { frontend: 'chat', autonomy: 'confirm-everything', respond: 'approve' },
  { frontend: 'chat', autonomy: 'unattended', respond: 'approve' },
  { frontend: 'tui', autonomy: 'confirm-everything', respond: 'approve' },
  { frontend: 'tui', autonomy: 'unattended', respond: 'approve' },
];

/**
 * Which Layer 2 cells run under which front-end.
 *
 * The full A+B suite runs under both front-ends at both autonomy levels; C only
 * needs the two front-ends at confirm-everything (a refusal is the same code
 * path either way, and the interesting claim is that both front-ends show it);
 * D is a chat usability smoke.
 */
export function layer2Plan() {
  const plan = [];
  const push = (cell, variants) => {
    for (const variant of variants) plan.push({ cell, ...variant });
  };
  for (const cell of [...A_CELLS, ...B_CELLS]) push(cell, LAYER2_VARIANTS);
  for (const cell of C_CELLS) push(cell, LAYER2_VARIANTS);
  for (const cell of D_CELLS) {
    push(cell, [LAYER2_VARIANTS[0], LAYER2_VARIANTS[1]]);
  }
  return plan;
}
