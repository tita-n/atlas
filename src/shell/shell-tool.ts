import { z } from 'zod';
import { AuditLog } from '../audit/audit-log.js';
import type { ConfirmationFlow } from '../permissions/confirmation-flow.js';
import type { RiskClassifier } from '../permissions/risk-classifier.js';
import type { PermissionGrantStore } from '../permissions/grant-store.js';
import type {
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutor,
  ToolCall,
} from '../providers/provider.interface.js';
import type { ShellSession } from './shell-session.js';
import { maxToolOutputChars, truncateToolOutput } from './output-limit.js';

const shellArgumentsSchema = z.object({
  command: z.string().trim().min(1).max(20_000),
});

/** Dependencies for the harness-owned shell tool. */
export interface ShellToolOptions {
  /** Persistent shell process used for execution. */
  session: ShellSession;
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
  /** Optional user-facing notice callback. */
  onNotice?: ((message: string) => void) | undefined;
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
  readonly #session: ShellSession;
  readonly #classifier: RiskClassifier;
  readonly #confirmation: ConfirmationFlow;
  readonly #auditLog: AuditLog;
  readonly #name: string;
  readonly #grantStore: PermissionGrantStore | undefined;
  readonly #onNotice: ((message: string) => void) | undefined;
  readonly #onActivity: ((message: string) => void) | undefined;
  #signal: AbortSignal | undefined;

  public constructor(options: ShellToolOptions) {
    this.#session = options.session;
    this.#classifier = options.classifier;
    this.#confirmation = options.confirmation;
    this.#auditLog = options.auditLog;
    this.#name = options.name ?? 'shell';
    this.#grantStore = options.grantStore;
    this.#onNotice = options.onNotice;
    this.#onActivity = options.onActivity;
    this.#signal = options.signal;
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

    if (assessment.tier === 1 || assessment.decision === 'deny') {
      this.#auditLog.append({
        timestamp,
        command,
        riskTier: assessment.tier,
        matchedRule: assessment.matchedRule.id,
        decision: 'blocked',
        outcome: 'not executed',
        exitCode: null,
        durationMs: null,
      });
      return {
        content:
          'This action is permanently blocked by Atlas and was not executed.',
        isError: true,
      };
    }

    let approved = true;
    if (assessment.requiresConfirmation || assessment.tier === 3) {
      try {
        const outcome = await this.#confirmation.review(command, assessment);
        approved = outcome.approved;
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
            decision: 'asked-denied',
            outcome: 'not executed',
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
          decision: 'asked-denied',
          outcome: 'confirmation failed',
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
        decision: assessment.requiresConfirmation
          ? 'asked-approved'
          : 'allowed',
        outcome: result.timedOut
          ? `timed out after ${result.durationMs}ms`
          : `exit code ${result.exitCode}`,
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
        decision: assessment.requiresConfirmation
          ? 'asked-approved'
          : 'allowed',
        outcome: 'shell execution error',
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
