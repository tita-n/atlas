import { z } from 'zod';
import { AuditLog } from '../audit/audit-log.js';
import { homedir } from 'node:os';
import type { ConfirmationFlow } from '../permissions/confirmation-flow.js';
import type { GatePath } from '../audit/audit-log.schema.js';
import type { AuditEntryInput } from '../audit/audit-log.schema.js';
import type { ProtectionProfile } from '../execution/environment.js';

import { describeCommand, planDryRun } from '../permissions/dry-run.js';
import { hardFloorVerdict } from '../permissions/autonomy.js';
import type { RiskAssessment } from '../permissions/risk-classifier.js';
import type { RiskClassifier } from '../permissions/risk-classifier.js';
import type { PermissionGrantStore } from '../permissions/grant-store.js';
import type {
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutor,
  ToolCall,
} from '../providers/provider.interface.js';
import type { ExecutionSession } from '../execution/environment.js';
import { maxToolOutputChars, truncateToolOutput } from './output-limit.js';

const shellArgumentsSchema = z.object({
  command: z.string().trim().min(1).max(20_000),
  /**
   * Preview the command instead of running it.
   *
   * A preview never executes the command as written. Where the tool has a
   * genuine native preview flag, that is used; otherwise Atlas describes the
   * command and runs nothing.
   */
  dryRun: z.boolean().optional(),
});

/** Dependencies for the harness-owned shell tool. */
export interface ShellToolOptions {
  /** Persistent execution context: a host shell, or a sandboxed one. */
  session: ExecutionSession;
  /** Code-only risk classifier. */
  classifier: RiskClassifier;
  /** Explanation and confirmation gate. */
  confirmation: ConfirmationFlow;
  /** Append-only audit writer. */
  auditLog: AuditLog;
  /** Structured tool name exposed to the model. */
  name?: string | undefined;
  /** Store for explicit durable approval grants. */
  grantStore?: PermissionGrantStore | undefined;
  /** The user's home directory, used to judge home-scoped commands. */
  home?: string | undefined;
  /** Optional user-facing notice callback. */
  onNotice?: ((message: string) => void) | undefined;
  /**
   * The gate path that applies when the user TYPED the confirmation.
   *
   * This is only the fallback. It used to be stamped onto every row in the
   * session regardless of what actually happened, which made the column a
   * restatement of a configuration flag rather than a record of the decision.
   * The real path is derived per command; see {@link ShellTool.#gatePathFor}.
   */
  gatePath?: GatePath | undefined;
  /**
   * The isolation in force, stamped onto every audit row.
   *
   * Read at write time, not at construction: a session that escalates out of
   * the sandbox mid-run must have later rows say so.
   */
  sandbox?:
    | (() => {
        backend: 'local' | 'bwrap';
        profile: ProtectionProfile;
        writableRoots: string[];
        networkEnabled: boolean;
        escalated: boolean;
      })
    | undefined;
  /**
   * The autonomy level currently in force, stamped onto every audit row.
   *
   * A function rather than a value so a level changed mid-session is reflected
   * without rebuilding the tool.
   */
  autonomy?:
    (() => 'confirm-everything' | 'scoped-approval' | 'unattended') | undefined;
  /** Runs a command in preview mode; absent disables dry-run entirely. */
  dryRun?: ((command: string) => Promise<string>) | undefined;
  /**
   * Called just before a command runs, so the REPL can show that work is in
   * flight instead of leaving the terminal silent.
   */
  onActivity?: ((message: string) => void) | undefined;
  /** Cancels a running command when the caller aborts the turn. */
  signal?: AbortSignal | undefined;
}

/** Model-facing shell tool whose execution always passes through Atlas gates. */
export class ShellTool implements ToolExecutor {
  readonly #session: ExecutionSession;
  readonly #classifier: RiskClassifier;
  readonly #confirmation: ConfirmationFlow;
  readonly #auditLog: AuditLog;
  readonly #name: string;
  readonly #grantStore: PermissionGrantStore | undefined;
  readonly #onNotice: ((message: string) => void) | undefined;
  readonly #onActivity: ((message: string) => void) | undefined;
  readonly #gatePath: GatePath | undefined;
  readonly #dryRun: ((command: string) => Promise<string>) | undefined;
  readonly #home: string | undefined;
  readonly #autonomy:
    (() => 'confirm-everything' | 'scoped-approval' | 'unattended') | undefined;
  #signal: AbortSignal | undefined;
  readonly #sandbox: (() => NonNullable<AuditEntryInput['sandbox']>) | undefined;
  /** Set while a command is running outside the sandbox by explicit grant. */
  #escalated = false;

  public constructor(options: ShellToolOptions) {
    this.#session = options.session;
    this.#classifier = options.classifier;
    this.#confirmation = options.confirmation;
    this.#auditLog = options.auditLog;
    this.#gatePath = options.gatePath;
    this.#dryRun = options.dryRun;
    this.#autonomy = options.autonomy;
    this.#home = options.home ?? homedir();
    this.#name = options.name ?? 'shell';
    this.#grantStore = options.grantStore;
    this.#onNotice = options.onNotice;
    this.#onActivity = options.onActivity;
    this.#signal = options.signal;
    this.#sandbox = options.sandbox;
  }

  /**
   * The isolation context for the next audit row.
   *
   * `escalated` is per-command, not per-session: a grant that ran one command
   * outside the sandbox must not make the NEXT row claim the same, which is the
   * same class of bug as the constant `gate_path` this replaced.
   */
  #sandboxContext(): NonNullable<AuditEntryInput['sandbox']> | undefined {
    const current = this.#sandbox?.();
    if (current === undefined) return undefined;
    return {
      backend: current.backend,
      profile: current.profile,
      writableRoots: [...current.writableRoots],
      networkEnabled: current.networkEnabled,
      escalated: current.escalated || this.#escalated,
    };
  }

  /**
   * The `sandbox` field for an audit row, or nothing.
   *
   * Reads {@link #sandboxContext} once. Spreading
   * `#sandboxContext() === undefined ? {} : { sandbox: #sandboxContext() }`
   * called it twice per row; harmless for a stable closure, but a caller that
   * reads live state could produce two different objects, and only the second
   * was recorded.
   */
  #sandboxField(): { sandbox?: NonNullable<AuditEntryInput['sandbox']> } {
    const sandbox = this.#sandboxContext();
    return sandbox === undefined ? {} : { sandbox };
  }

  /**
   * Which path REALLY decided this command.
   *
   * Derived per command from what actually happened, because the column exists
   * to be truthful:
   *
   *   - the hard floor refused it            -> denied-hard-floor
   *   - the user was asked and said yes      -> the typed/voice path in force
   *   - the user was asked and said no       -> the same path, with decision=asked-denied
   *   - refused without asking (block mode)  -> hard-block
   *   - nobody was asked, and a sandbox held -> auto-allow-sandboxed
   *   - nobody was asked, nothing confined   -> auto-allow
   *   - it ran outside the sandbox by grant  -> escalated-out-of-sandbox
   */
  #gatePathFor(outcome: {
    asked: boolean;
    denied?: boolean;
  }): GatePath {
    if (this.#escalated) return 'escalated-out-of-sandbox';
    if (outcome.denied === true) {
      // A denial still has to name the path that produced it. Falling through
      // to the auto-allow branches below would put an ALLOW path on a row whose
      // outcome is `denied`, and claiming the typed-safe-word path when nobody
      // was asked is the same class of lie the column exists to prevent.
      return outcome.asked ? (this.#gatePath ?? 'text-safe-word') : 'hard-block';
    }
    if (outcome.asked) return this.#gatePath ?? 'text-safe-word';
    return this.#sandboxContext()?.backend === 'bwrap'
      ? 'auto-allow-sandboxed'
      : 'auto-allow';
  }

  /**
   * Whether the command currently in flight is running outside the sandbox.
   *
   * Read by the audit writer, which cannot see the private flag, so the two
   * columns that describe confinement cannot disagree.
   *
   * NOTE: nothing in the product calls {@link setEscalated} yet. The escalation
   * PROMPT is not wired to a front-end; see the report's "not done" section.
   * Until it is, `escalated` is always false and
   * `escalated-out-of-sandbox` is unreachable in production - the audit
   * vocabulary and the flag exist, the flow that would set them does not.
   */
  public isEscalated(): boolean {
    return this.#escalated;
  }

  /**
   * Marks subsequent commands as running outside the sandbox.
   *
   * Set by the escalation path, cleared as soon as the grant is spent, so the
   * flag describes one command rather than the rest of the session.
   */
  public setEscalated(escalated: boolean): void {
    this.#escalated = escalated;
  }

  /**
   * Updates the cancellation signal used for the next command.
   *
   * The REPL creates a fresh signal per turn, so this is set at the start of
   * every turn rather than only at construction.
   */
  public setAbortSignal(signal: AbortSignal | undefined): void {
    this.#signal = signal;
  }

  /** Structured tool definition exposed to the provider. */
  public get definition(): ToolDefinition {
    return {
      name: this.#name,
      description:
        "Run one shell command on the user's computer. Use only when the user explicitly asks for a shell action. Return the command output and exit status.",
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The complete shell command to execute.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    };
  }

  /**
   * Previews a command and records that it was only previewed.
   *
   * Deliberately does not consult the permission gate: previewing is always
   * safe and must stay available for exactly the commands you want to check
   * before deciding about them.
   */
  async #preview(
    command: string,
    assessment: RiskAssessment,
    timestamp: string,
  ): Promise<ToolExecutionResult> {
    const plan = planDryRun(command);
    const lines = [`Preview only — "${command}" was not executed.`];
    lines.push(describeCommand(command));
    let output = '';
    if (plan.method === 'native' && this.#dryRun !== undefined) {
      try {
        output = await this.#dryRun(plan.command);
      } catch (error) {
        output = `The native preview could not be completed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (plan.caveat !== undefined) lines.push(plan.caveat);
    if (output !== '') {
      lines.push(
        plan.method === 'native'
          ? `native preview (${plan.command}):`
          : 'description:',
        output.trim(),
      );
    }
    this.#auditLog.append({
      timestamp,
      command,
      summary: describeCommand(command),
      riskTier: assessment.tier,
      matchedRule: assessment.matchedRule.id,
      decision: 'previewed',
      outcome: 'previewed-only',
      exitCode: null,
      durationMs: null,
      gatePath: null,
      autonomy: this.#autonomy?.() ?? 'confirm-everything',
      ...this.#sandboxField(),
    });
    return { content: lines.join('\n') };
  }

  /** Executes one model-requested command after permission and audit handling. */
  public async execute(toolCall: ToolCall): Promise<ToolExecutionResult> {
    if (toolCall.name !== this.#name) {
      return {
        content: `Unknown tool: ${toolCall.name}. Nothing was executed.`,
        isError: true,
      };
    }
    const parsed = shellArgumentsSchema.safeParse(toolCall.arguments);
    if (!parsed.success) {
      return {
        content:
          'The shell tool requires a non-empty string field named command. Nothing was executed.',
        isError: true,
      };
    }

    const command = parsed.data.command;
    // Grants bind to the directory the persistent shell is really in,
    // which is not necessarily the Node process cwd after an earlier `cd`.
    const cwd = this.#session.currentDirectory;
    const assessment = this.#classifier.assess(command, cwd);
    const timestamp = new Date().toISOString();

    // Preview runs before any gate: seeing what a command would do must not
    // require approving it first, and a preview never executes the command.
    if (parsed.data.dryRun === true && this.#dryRun !== undefined) {
      return await this.#preview(command, assessment, timestamp);
    }

    if (assessment.tier === 1 || assessment.decision === 'deny') {
      this.#auditLog.append({
        timestamp,
        command,
        riskTier: assessment.tier,
        matchedRule: assessment.matchedRule.id,
        decision: 'blocked',
        outcome: 'denied',
        // 'hard-block' and 'denied-hard-floor' are different facts. This one is
        // the classifier's permanent refusal, not the unconditional floor; the
        // floor's own refusal is recorded below as 'denied-hard-floor'. Block
        // mode is NOT this branch - it refuses one layer down, in
        // ConfirmationFlow, and lands on the denial rows with decision
        // 'blocked' and gate path 'hard-block'.
        gatePath: 'hard-block',
        autonomy: this.#autonomy?.() ?? 'confirm-everything',
        ...this.#sandboxField(),
        exitCode: null,
        durationMs: null,
      });
      return {
        content:
          'This action is permanently blocked by Atlas and was not executed.',
        isError: true,
      };
    }

    // The hard floor is evaluated here, not only inside ConfirmationFlow.
    // A durable grant used to drop a command to tier 0, which skipped
    // review() entirely - and review() was the only place the floor ran, so one
    // remembered approval disabled it permanently.
    const floor = hardFloorVerdict(command, { home: this.#home });
    if (floor.applies) {
      this.#auditLog.append({
        timestamp,
        command,
        summary: floor.reason ?? 'unrecoverable action',
        riskTier: assessment.tier,
        matchedRule: assessment.matchedRule.id,
        decision: 'blocked',
        outcome: 'denied',
        // The floor fired, which is a different event from a classifier block
        // and the one an auditor most needs to see separately: the floor is
        // not skippable by any grant.
        gatePath: 'denied-hard-floor',
        autonomy: this.#autonomy?.() ?? 'confirm-everything',
        ...this.#sandboxField(),
        exitCode: null,
        durationMs: null,
      });
      return {
        content:
          floor.reason ??
          'This action is permanently blocked by Atlas and was not executed.',
        isError: true,
      };
    }

    let approved = true;
    // Whether a HUMAN was actually asked, as opposed to the command merely
    // being one that usually needs asking.
    //
    // `requiresConfirmation` is not that flag: under `unattended`, or with a
    // durable grant, a command with requiresConfirmation=true is approved
    // without anyone being prompted. Using the classifier's flag as a proxy
    // wrote `asked-approved` / `text-safe-word` onto rows where nobody typed a
    // safe word, which is the exact lie this column exists to prevent.
    let confirmationRequested = false;
    if (assessment.requiresConfirmation || assessment.tier === 3) {
      try {
        const outcome = await this.#confirmation.review(command, assessment);
        approved = outcome.approved;
        confirmationRequested = outcome.confirmationRequested;
        if (outcome.choice === 'remember' && approved) {
          try {
            const remembered = await this.#grantStore?.remember(
              command,
              this.#session.currentDirectory,
            );
            if (remembered === undefined) {
              this.#onNotice?.(
                'Approved once. Durable grants are unavailable in this session.',
              );
            } else if (remembered.persisted) {
              this.#onNotice?.(
                'Approved and remembered for this exact command and working directory.',
              );
            } else {
              this.#onNotice?.(
                `Approved once; not remembered: ${remembered.reason ?? 'the command is not eligible for durable approval.'}`,
              );
            }
          } catch {
            this.#onNotice?.(
              'Approved once; the durable grant could not be saved.',
            );
          }
        }
        if (!approved) {
          this.#auditLog.append({
            timestamp,
            command,
            riskTier: assessment.tier,
            matchedRule: assessment.matchedRule.id,
            // `confirmationRequested` is what actually happened. Under
            // ATLAS_TEXT_CONFIRM_MODE=block the flow refuses WITHOUT asking and
            // reports false, so a hardcoded `asked-denied` here wrote a human
            // denial onto a mechanical refusal - the exact lie this row exists
            // to prevent.
            decision: confirmationRequested ? 'asked-denied' : 'blocked',
            outcome: 'denied',
            // Not a floor denial: the floor has its own path, and conflating
            // the two would hide which mechanism actually stopped the command.
            gatePath: this.#gatePathFor({
              asked: confirmationRequested,
              denied: true,
            }),
            autonomy: this.#autonomy?.() ?? 'confirm-everything',
            ...this.#sandboxField(),
            exitCode: null,
            durationMs: null,
          });
          return {
            content:
              'The user declined this command, so nothing was executed. Do not ' +
              'retry this command or a similar one. Continue with the ' +
              'information you already have, or tell the user exactly which ' +
              'command you would need and why.',
            isError: true,
          };
        }
      } catch (error) {
        this.#auditLog.append({
          timestamp,
          command,
          riskTier: assessment.tier,
          matchedRule: assessment.matchedRule.id,
          // The confirmation machinery failed; nothing was put to a human, so
          // the row must not claim one answered.
          decision: confirmationRequested ? 'asked-denied' : 'blocked',
          outcome: 'denied',
          gatePath: this.#gatePathFor({
            asked: confirmationRequested,
            denied: true,
          }),
          autonomy: this.#autonomy?.() ?? 'confirm-everything',
          ...this.#sandboxField(),
          exitCode: null,
          durationMs: null,
        });
        return {
          content:
            error instanceof Error
              ? `Confirmation failed: ${error.message}`
              : 'Confirmation failed. Nothing was executed.',
          isError: true,
        };
      }
    }

    try {
      this.#onActivity?.(command);
      const result = await this.#session.execute(
        command,
        undefined,
        this.#signal,
      );
      this.#auditLog.append({
        timestamp,
        command,
        riskTier: assessment.tier,
        matchedRule: assessment.matchedRule.id,
        decision: confirmationRequested ? 'asked-approved' : 'allowed',
        // Says what actually happened, not what usually happens: a row written
        // under unattended never had anyone type a safe word.
        gatePath: this.#gatePathFor({ asked: confirmationRequested }),
        autonomy: this.#autonomy?.() ?? 'confirm-everything',
        ...this.#sandboxField(),
        // The exit code and duration live in their own columns, so the
        // outcome is a queryable state rather than a sentence.
        outcome:
          result.timedOut || result.exitCode !== 0 ? 'failed' : 'succeeded',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      // One budget for the whole tool result, split across both streams, so
      // a command that writes heavily to both cannot double the cap.
      const cap = maxToolOutputChars();
      const stderrShare = Math.min(result.stderr.length, Math.floor(cap / 2));
      const stdoutBudget = Math.max(1, cap - stderrShare);
      const stdout = truncateToolOutput(result.stdout, {
        maxChars: stdoutBudget,
      });
      const stderr = truncateToolOutput(result.stderr, {
        maxChars: Math.max(1, cap - stdout.keptChars),
      });
      const wasTruncated = stdout.truncated || stderr.truncated;

      return {
        content: [
          `Exit code: ${result.exitCode}`,
          `Duration: ${result.durationMs}ms`,
          result.cancelled === true
            ? 'The user cancelled this command, so it was stopped.'
            : '',
          result.timedOut ? 'The command timed out and was killed.' : '',
          wasTruncated
            ? 'Note: this output was shortened, so it may be incomplete.'
            : '',
          `Stdout:\n${stdout.text}`,
          `Stderr:\n${stderr.text}`,
        ]
          .filter((part) => part !== '')
          .join('\n'),
        isError:
          result.exitCode !== 0 || result.timedOut || result.cancelled === true,
      };
    } catch (error) {
      this.#auditLog.append({
        timestamp,
        command,
        riskTier: assessment.tier,
        matchedRule: assessment.matchedRule.id,
        decision: confirmationRequested ? 'asked-approved' : 'allowed',
        // A failure to execute is still a decision the gate made, so it names
        // the path that made it rather than dropping the attribution.
        gatePath: this.#gatePathFor({ asked: confirmationRequested }),
        autonomy: this.#autonomy?.() ?? 'confirm-everything',
        ...this.#sandboxField(),
        outcome: 'failed',
        exitCode: null,
        durationMs: null,
      });
      return {
        content:
          error instanceof Error
            ? `Shell execution failed: ${error.message}`
            : 'Shell execution failed. Nothing was executed.',
        isError: true,
      };
    }
  }
}
