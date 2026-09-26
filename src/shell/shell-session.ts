import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ShellSessionError } from '../errors.js';
import type { CommandResult } from './command-result.js';
import { BoundedStreamBuffer } from './bounded-buffer.js';

/** Options for the long-lived bash process. */
export interface ShellSessionOptions {
  /** Shell executable, defaults to bash. */
  shellPath?: string | undefined;
  /** Arguments used to start the shell. */
  shellArgs?: readonly string[] | undefined;
  /** Default per-command timeout in milliseconds. */
  timeoutMs?: number | undefined;
  /** Environment inherited by the shell. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Initial working directory. */
  cwd?: string | undefined;
}

interface PendingCommand {
  marker: string;
  stdout: BoundedStreamBuffer;
  stderr: BoundedStreamBuffer;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: CommandResult) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function shellMarker(): string {
  return `__ATLAS_DONE_${randomUUID().replaceAll('-', '')}__`;
}

function encodeCommand(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64');
}

/** A single persistent bash process used for all shell tool calls in a session. */
/**
 * Removes the single newline the wrapper prints before its marker line.
 *
 * Without this, every result carries one phantom trailing blank line.
 */
function trimMarkerNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export class ShellSession {
  readonly #shellPath: string;
  readonly #shellArgs: readonly string[];
  readonly #timeoutMs: number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #cwd: string | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #pending: PendingCommand | undefined;
  #currentDirectory: string;
  #closed = false;

  public constructor(options: ShellSessionOptions = {}) {
    this.#shellPath = options.shellPath ?? 'bash';
    this.#shellArgs = options.shellArgs ?? ['--noprofile', '--norc'];
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#env = options.env ?? process.env;
    this.#cwd = options.cwd;
    this.#currentDirectory = options.cwd ?? process.cwd();
  }

  /**
   * The directory commands actually run in.
   *
   * The shell is long lived and a command may `cd`, so this is not the Node
   * process cwd. Permission grants are bound to it.
   */
  public get currentDirectory(): string {
    return this.#currentDirectory;
  }

  /** Whether the underlying shell process is currently available. */
  public get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  /** Executes one command in the persistent shell. */
  public execute(
    command: string,
    timeoutMs = this.#timeoutMs,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (this.#closed) {
      return Promise.reject(new ShellSessionError('Shell session is closed.'));
    }
    if (command.trim() === '') {
      return Promise.reject(
        new ShellSessionError('Shell command cannot be empty.'),
      );
    }
    if (this.#pending !== undefined) {
      return Promise.reject(
        new ShellSessionError('Shell session already has a command in flight.'),
      );
    }

    this.#ensureProcess();
    const child = this.#child;
    if (child === undefined) {
      return Promise.reject(
        new ShellSessionError('Could not start the shell.'),
      );
    }

    const marker = shellMarker();
    const startedAt = Date.now();
    return new Promise<CommandResult>((resolve, reject) => {
      // Checked before any state is created: an already-aborted signal would
      // otherwise leave this promise pending forever, because the abort
      // listener below can never fire for a signal that already fired.
      if (signal?.aborted === true) {
        resolve({
          stdout: '',
          stderr: '',
          exitCode: 130,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          cancelled: true,
        });
        return;
      }

      const onAbort = (): void => {
        if (this.#pending?.marker !== marker) return;
        // The command is stopped the same way a timeout stops it, so the
        // caller still receives a normal result instead of a rejection.
        const result = { ...this.#buildResult(130, false), cancelled: true };
        this.#finishPending(result);
        this.#terminateProcess();
        resolve(result);
      };
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timeout = setTimeout(() => {
        if (this.#pending?.marker !== marker) return;
        const result = this.#buildResult(124, true);
        this.#finishPending(result);
        this.#terminateProcess();
        resolve(result);
      }, timeoutMs);

      this.#pending = {
        marker,
        stdout: new BoundedStreamBuffer(),
        stderr: new BoundedStreamBuffer(),
        startedAt,
        timeout,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined ? {} : { onAbort }),
      };

      const encoded = encodeCommand(command);
      // The payload is decoded into a variable first so the wrapper can prove
      // it actually ran. `eval -- ""` succeeds on an empty payload, so after
      // something like `unset PATH` breaks `base64` the command would
      // otherwise be reported as a successful no-op.
      const script = [
        'set +e',
        `__atlas_payload="$(printf '%s' '${encoded}' | base64 --decode 2>/dev/null)"`,
        '__atlas_ran=0',
        '__atlas_status=127',
        'if [ -n "$__atlas_payload" ]; then',
        '  __atlas_ran=1',
        '  eval -- "$__atlas_payload"',
        '  __atlas_status=$?',
        'fi',
        `printf '\\n${marker}:%s:%s:out\\n' "$__atlas_ran" "$__atlas_status"`,
        `printf '\\n${marker}:%s:%s:err\\n' "$__atlas_ran" "$__atlas_status" >&2`,
        `printf '\\n${marker}:%s:pwd\\n' "$PWD"`,
        '',
      ].join('\n');

      child.stdin.write(script, (error) => {
        if (error !== undefined && error !== null) {
          this.#rejectPending(
            new ShellSessionError('Could not write to the shell process.', {
              cause: error,
            }),
          );
        }
      });
    });
  }

  /** Restarts bash, discarding a hung or corrupted session. */
  public restart(): void {
    this.#rejectPending(
      new ShellSessionError('Shell session was restarted before completion.'),
    );
    this.#terminateProcess();
    if (!this.#closed) this.#ensureProcess();
  }

  /** Closes the shell and rejects any in-flight command. */
  public close(): void {
    this.#closed = true;
    this.#rejectPending(new ShellSessionError('Shell session was closed.'));
    this.#terminateProcess();
  }

  #ensureProcess(): void {
    if (this.running) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#shellPath, [...this.#shellArgs], {
        cwd: this.#cwd,
        env: this.#env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new ShellSessionError('Could not start the bash process.', {
        cause: error,
      });
    }
    this.#child = child;
    child.stdout.on('data', (chunk: Buffer | string) => {
      this.#onStdout(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.#onStderr(chunk.toString());
    });
    child.once('error', (error) => {
      this.#onProcessExit(
        new ShellSessionError('Shell process failed.', { cause: error }),
      );
    });
    child.once('exit', (code, signal) => {
      if (this.#child !== child) return;
      if (this.#pending !== undefined) {
        this.#rejectPending(
          new ShellSessionError(
            `Shell exited before command completion (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`,
          ),
        );
      }
      this.#child = undefined;
    });
  }

  #onProcessExit(error: ShellSessionError): void {
    this.#rejectPending(error);
    this.#child = undefined;
  }

  #onStdout(chunk: string): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    pending.stdout.append(chunk);
    this.#tryFinishPending();
  }

  #onStderr(chunk: string): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    pending.stderr.append(chunk);
    this.#tryFinishPending();
  }

  #tryFinishPending(): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    const stdoutMarker = this.#findMarkerLine(pending.stdout, pending.marker);
    const stderrMarker = this.#findMarkerLine(pending.stderr, pending.marker);
    const pwdMarker = this.#findMarkerLine(
      pending.stdout,
      pending.marker,
      'pwd',
    );
    // The directory is reported on the same stream, so waiting for it keeps
    // the result and currentDirectory in step and stops one command's pwd
    // line from being attributed to the next.
    if (
      stdoutMarker === undefined ||
      stderrMarker === undefined ||
      pwdMarker === undefined ||
      pwdMarker.index < stdoutMarker.index
    ) {
      return;
    }

    // The shell reports its own cwd after every command, so the directory a
    // grant is bound to is the directory commands really run in, even after
    // an earlier `cd`.
    this.#readReportedDirectory(pending.stdout, pending.marker);

    const stdoutStatus = Number(stdoutMarker.value);
    const stderrStatus = Number(stderrMarker.value);

    const status = Number.isInteger(stdoutStatus) ? stdoutStatus : stderrStatus;

    // An empty status means the wrapper itself could not run the payload,
    // for example after a command unset PATH and broke `base64`. Reporting
    // that as success would tell the model a command ran when it never did.
    if (stdoutMarker.ran.trim() !== '1') {
      this.#finishPending({
        stdout:
          'Atlas could not run the command: the shell could not decode it ' +
          '(this usually follows a command that broke the shell, such as ' +
          '`unset PATH`). The shell has been restarted.\n',
        stderr: '',
        exitCode: 127,
        durationMs: Date.now() - pending.startedAt,
        timedOut: false,
      });
      this.#terminateProcess();
      return;
    }

    const result = this.#buildResult(
      Number.isInteger(status) ? status : 1,
      false,
    );
    // Tell the caller explicitly when earlier output was discarded, so the
    // model is never handed a silently shortened result.
    this.#finishPending({
      ...result,
      stdout:
        pending.stdout.droppedNotice() +
        trimMarkerNewline(pending.stdout.prefix(stdoutMarker.index)),
      stderr:
        pending.stderr.droppedNotice() +
        trimMarkerNewline(pending.stderr.prefix(stderrMarker.index)),
    });
  }

  /**
   * Finds the first well-formed completion marker line in a stream.
   *
   * The wrapper emits three lines, and the pwd line carries no status:
   *   MARKER:<status>:out
   *   MARKER:<status>:err      (on stderr)
   *   MARKER:<path>:pwd
   * Only those exact shapes count, so command output that merely resembles a
   * marker cannot end the command early, and the marker lines are cut from the
   * result so they never reach the caller.
   */
  #findMarkerLine(
    buffer: BoundedStreamBuffer,
    marker: string,
    kind?: 'out' | 'err' | 'pwd',
  ): { index: number; ran: string; value: string } | undefined {
    const text = buffer.prefix(Number.POSITIVE_INFINITY);
    const pattern =
      kind === 'pwd'
        ? new RegExp(`^${marker}:(.+):pwd$`, 'm')
        : new RegExp(`^${marker}:([^:]*):([^:]*):(?:out|err)$`, 'm');
    const match = pattern.exec(text);
    if (match === null) return undefined;
    const index = match.index;
    // Only treat it as a completion if the match starts its own line.
    if (index !== 0 && text[index - 1] !== '\n') return undefined;
    // For out/err the groups are the "did it run" flag and the status; for
    // pwd the single group is the directory.
    return kind === 'pwd'
      ? { index, ran: '', value: match[1] ?? '' }
      : { index, ran: match[1] ?? '', value: match[2] ?? '' };
  }

  /** Records the directory the shell reported for the finished command. */
  #readReportedDirectory(buffer: BoundedStreamBuffer, marker: string): void {
    const found = this.#findMarkerLine(buffer, marker, 'pwd');
    if (found === undefined) return;
    if (found.value !== '') this.#currentDirectory = found.value;
  }

  #buildResult(exitCode: number, timedOut: boolean): CommandResult {
    const pending = this.#pending;
    return {
      stdout: pending?.stdout.toString() ?? '',
      stderr: pending?.stderr.toString() ?? '',
      exitCode,
      durationMs: pending === undefined ? 0 : Date.now() - pending.startedAt,
      timedOut,
    };
  }

  #finishPending(result: CommandResult): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.#pending = undefined;
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.resolve(result);
  }

  #rejectPending(error: unknown): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.#pending = undefined;
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.reject(error);
  }

  #terminateProcess(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined) return;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 1000);
    child.once('exit', () => {
      clearTimeout(killTimer);
    });
    child.stdin.destroy();
  }
}
