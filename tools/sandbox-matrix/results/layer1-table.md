Layer 1 runs: 122
verdicts: {"PASS":122}
profiles: {"read-only":61,"workspace-write":61}
records not executed: 0
records with findings: 0

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