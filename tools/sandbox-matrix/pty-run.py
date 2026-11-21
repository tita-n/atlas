"""
Drive a command on a pty, feeding it a scripted sequence and quitting it.

The TUI reads a composer line rather than stdin lines, and it exits on Ctrl+D,
so a plain `< file` pipe hangs until the harness timeout and every cell reports
a harness failure instead of a result.

Why a schedule rather than "send everything up front": a confirmation modal does
not exist until the model has replied, and keystrokes typed before it is mounted
are lost. So a step can WAIT FOR a substring of output before sending, which is
what makes approve-once and deny-once deterministic instead of a timing race.

PTY_SCHEDULE is JSON. Three step shapes:
  {"wait": 1.0}                                pause
  {"send": "hello\\r"}                          send now
  {"waitFor": "Run it", "timeout": 8,
   "send": "y"}                                wait for output, then send

Legacy single-shot mode (PTY_INPUT) is kept for the old callers.
"""
import json
import os
import pty
import select
import sys
import time

QUIET_SECONDS = float(os.environ.get("PTY_QUIET", "3"))
TOTAL_TIMEOUT = float(os.environ.get("PTY_TIMEOUT", "120"))
QUIET_AFTER_EOF = float(os.environ.get("PTY_QUIET_AFTER_EOF", "2"))

master, slave = pty.openpty()
os.set_blocking(slave, True)

argv = sys.argv[1:]
schedule = []
if os.environ.get("PTY_SCHEDULE"):
    schedule = json.loads(os.environ["PTY_SCHEDULE"])
legacy = os.environ.get("PTY_INPUT", "")
if legacy and not schedule:
    schedule = [{"send": legacy}]

pid = os.fork()
if pid == 0:
    os.close(master)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.execvp(argv[0], argv)
    os._exit(127)

os.close(slave)
os.set_blocking(master, False)

start = time.time()
last_output = time.time()
sent_eof = False
out = bytearray()
index = 0
deadline = None  # a pending {"wait": N} step


def drain():
    """Read everything currently available. Returns True if we saw new bytes."""
    got = False
    while True:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            return got
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return got
        if not chunk:
            return got
        out.extend(chunk)
        got = True


while True:
    now = time.time()
    if now - start > TOTAL_TIMEOUT:
        break

    if drain():
        last_output = now

    if index >= len(schedule):
        # All steps sent: once quiet, ask it to quit, then drain to EOF.
        if not sent_eof and time.time() - last_output > QUIET_SECONDS:
            try:
                os.write(master, b"\x04")
            except OSError:
                break
            sent_eof = True
            last_output = time.time()
            continue
        if sent_eof and time.time() - last_output > QUIET_AFTER_EOF:
            break
        time.sleep(0.05)
        continue

    if deadline is not None:
        if time.time() < deadline:
            time.sleep(0.05)
            continue
        deadline = None
        index += 1
        continue

    step = schedule[index]

    if "wait" in step:
        deadline = time.time() + float(step["wait"])
        continue

    if "waitFor" in step:
        needle = step["waitFor"].encode()
        limit = time.time() + float(step.get("timeout", 30))
        while needle not in bytes(out) and time.time() < limit:
            if drain():
                last_output = time.time()
            time.sleep(0.05)
        found = needle in bytes(out)
        payload = step.get("send", "")
        # omit: the send is conditional on the needle actually appearing. A
        # tier-0 command or an unattended run never mounts a confirmation
        # modal, so a blind 'y' would land in the composer as text and the
        # driver would be pressing keys into a dead prompt.
        if payload != "" and (found or not step.get("omit", False)):
            delay = float(step.get("delay", 0))
            if delay > 0:
                time.sleep(delay)
                drain()
            try:
                os.write(master, payload.encode())
            except OSError:
                break
        index += 1
        continue

    if "unlessSeen" in step:
        # Send only if the needle has never appeared. This is the inverse of
        # waitFor: a self-healing retry for a keystroke that may have been
        # swallowed, on the strict condition that the state it belongs to
        # never happened (e.g. the turn never started, so no modal can be
        # mounted and an extra Enter cannot hit anything).
        needle = step["unlessSeen"].encode()
        if needle not in bytes(out):
            payload = step.get("send", "")
            if payload:
                try:
                    os.write(master, payload.encode())
                except OSError:
                    break
        index += 1
        continue

    if "send" in step:
        if step["send"] != "":
            try:
                os.write(master, step["send"].encode())
            except OSError:
                break
        index += 1
        continue

    index += 1

drain()
sys.stdout.buffer.write(bytes(out))
sys.stdout.buffer.flush()

try:
    os.kill(pid, 9)
except OSError:
    pass
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(("\n__PTY_EXIT__=%d\n" % os.waitstatus_to_exitcode(status)).encode())
sys.stdout.buffer.flush()
