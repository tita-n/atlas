import type { LLMProvider } from '../providers/provider.interface.js';
import type { RiskAssessment } from './risk-classifier.js';
import { shouldAsk, type AutonomyLevel } from './autonomy.js';

/** Default typed safe phrase used until voice verification exists. */
export const DEFAULT_CONFIRMATION_PHRASE = 'ATLAS CONFIRM';

/** Request passed to the text confirmation stub. */
export interface ConfirmationRequest {
  /** Full command awaiting approval. */
  command: string;
  /** Risk explanation generated for the user. */
  explanation: string;
  /** Phrase the user must type exactly. */
  phrase: string;
  /** Whether the command needs the explicit sudo setup flow. */
  sudoSetupRequired: boolean;
}

/** User choice made by the confirmation stub. */
export type ConfirmationChoice = 'once' | 'remember' | 'deny';

/** Result of a permission review. */
export interface ConfirmationOutcome {
  /** Whether execution may proceed. */
  approved: boolean;
  /** User's one-shot, durable, or deny choice. */
  choice: ConfirmationChoice;
  /** Explanation shown or generated for the command. */
  explanation: string;
  /** Whether the text confirmation callback was invoked. */
  confirmationRequested: boolean;
  /** Whether this was the informational Tier 3 delay path. */
  informational: boolean;
}

/** Text confirmation callback, replaceable by voice verification in Phase 3. */
export type TextConfirmationResult = ConfirmationChoice | boolean;

/** Text confirmation callback, replaceable by voice verification in Phase 3. */
export type TextConfirmation = (
  request: ConfirmationRequest,
) => Promise<TextConfirmationResult>;

/** Optional dependencies for confirmation flow. */
export interface ConfirmationFlowOptions {
  /**
   * Whether this command must stop for a human regardless of autonomy level.
   *
   * Consulted before anything else, so no level - including unattended - can
   * wave through an unrecoverable action or an edit to Atlas's own safety
   * configuration. Returning false lets the configured level decide.
   */
  hardFloor?: ((command: string) => boolean) | undefined;

  /**
   * Autonomy level in force.
   *
   * Decides whether a dangerous-but-recoverable command still needs a person.
   * The hard floor is checked first and cannot be influenced by this.
   */
  autonomy?:
    | (() => {
        readonly level: AutonomyLevel;
        readonly scopedCategories?: readonly string[] | undefined;
      })
    | undefined;

  /** Existing provider used only to explain commands. */
  provider: LLMProvider;
  /** Model used for explanation requests. */
  model: string;
  /** Text confirmation implementation. */
  confirmText: TextConfirmation;
  /** Optional notice shown when the explanation model is unavailable. */
  onNotice?: ((message: string) => void) | undefined;
  /** Cancels the explanation request when the turn is aborted. */
  signal?: AbortSignal | undefined;
  /** Typed phrase required for Tier 2 approval. */
  phrase?: string | undefined;
  /** Delay for Tier 3 informational approval. */
  tier3DelayMs?: number | undefined;
  /** Injectable delay function for tests. */
  wait?: ((milliseconds: number) => Promise<void>) | undefined;
}

/** Handles explain, confirm, and abort behavior outside the execution layer. */
export class ConfirmationFlow {
  readonly #provider: LLMProvider;
  readonly #model: string;
  readonly #confirmText: TextConfirmation;
  readonly #onNotice: ((message: string) => void) | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #phrase: string;
  readonly #tier3DelayMs: number;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #hardFloor: ((command: string) => boolean) | undefined;
  readonly #autonomy: ConfirmationFlowOptions['autonomy'];

  public constructor(options: ConfirmationFlowOptions) {
    this.#provider = options.provider;
    this.#model = options.model;
    this.#confirmText = options.confirmText;
    this.#onNotice = options.onNotice;
    this.#signal = options.signal;
    this.#phrase = options.phrase ?? DEFAULT_CONFIRMATION_PHRASE;
    this.#tier3DelayMs = options.tier3DelayMs ?? 1500;
    // Assigned here, not only declared: leaving these unset made every read
    // resolve to undefined, so the hard-floor branch never ran and the
    // autonomy level silently degraded to the most conservative default.
    this.#hardFloor = options.hardFloor;
    this.#autonomy = options.autonomy;
    this.#wait =
      options.wait ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  /** Generates a plain-language explanation without exposing rule patterns. */
  public async explain(
    command: string,
    assessment: RiskAssessment,
  ): Promise<string> {
    const response = await this.#provider.chatCompletion({
      model: this.#model,
      maxTokens: 180,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Explain the requested shell command in plain language for the user. ' +
            'Say what it is likely to change and why confirmation is needed. ' +
            'Do not suggest bypassing confirmation, do not include internal rule IDs, ' +
            'and do not claim the command is safe or unsafe beyond the supplied reason.',
        },
        {
          role: 'user',
          content: `Command:\n${command}\n\nReason for review: ${assessment.reason}`,
        },
      ],
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
    });
    const explanation = response.content.trim();
    return explanation === '' ? assessment.reason : explanation;
  }

  /** Reviews a command according to its risk tier. */
  public async review(
    command: string,
    assessment: RiskAssessment,
  ): Promise<ConfirmationOutcome> {
    if (assessment.tier === 1 || assessment.decision === 'deny') {
      return {
        approved: false,
        choice: 'deny',
        explanation: 'This action is permanently blocked by Atlas.',
        confirmationRequested: false,
        informational: false,
      };
    }

    let explanation: string;
    try {
      explanation = await this.explain(command, assessment);
    } catch {
      // The model-written explanation is a convenience, not a safety gate.
      // If the provider is briefly unavailable, the user still gets asked,
      // using a factual local summary instead of a confusing failure.
      explanation =
        `${assessment.reason}\n\n` +
        `Command:\n${command}\n\n` +
        '(Atlas could not reach the model for a friendlier description, so ' +
        'this is the raw reason it was flagged.)';
      this.#onNotice?.(
        'Atlas could not generate a plain-language explanation for that ' +
          'command, so it is showing the raw reason instead.',
      );
    }

    // Checked BEFORE the tier-3 auto-allow and before any autonomy level.
    // Tier 3 used to short-circuit here, which meant a tier-3 command that
    // happened to touch Atlas's own configuration was allowed unprompted.
    // There must be no early return above this point that skips it.
    if (this.#hardFloor?.(command) === true) {
      // Uses the configured phrase rather than a hardcoded one, so a user who
      // changed the confirmation word still gets the prompt they expect.
      const answer = await this.#confirmText({
        command,
        explanation,
        phrase: this.#phrase,
        sudoSetupRequired: assessment.sudoSetupRequired,
      });
      const choice: ConfirmationChoice =
        typeof answer === 'boolean' ? (answer ? 'once' : 'deny') : answer;
      return {
        approved: choice !== 'deny',
        choice,
        explanation,
        confirmationRequested: true,
        informational: false,
      };
    }

    // Read at decision time, not at construction: a level changed while this
    // session is running must take effect immediately.
    const currentAutonomy = this.#autonomy?.();
    // Danger is decided by the classifier; this only decides whether a person is
    // asked. The hard floor has already had its say above.
    if (assessment.tier === 3) {
      await this.#wait(this.#tier3DelayMs);
      return {
        approved: true,
        choice: 'once',
        explanation,
        confirmationRequested: false,
        informational: true,
      };
    }

    if (
      !assessment.requiresConfirmation ||
      !shouldAsk({
        level: currentAutonomy?.level ?? 'confirm-everything',
        tier: assessment.tier,
        command,
        ...(assessment.category === undefined
          ? {}
          : { category: assessment.category }),
        ...(currentAutonomy?.scopedCategories === undefined
          ? {}
          : { scopedCategories: currentAutonomy.scopedCategories }),
      })
    ) {
      return {
        approved: true,
        choice: 'once',
        explanation,
        confirmationRequested: false,
        informational: false,
      };
    }

    const result = await this.#confirmText({
      command,
      explanation,
      phrase: this.#phrase,
      sudoSetupRequired: assessment.sudoSetupRequired,
    });
    const choice: ConfirmationChoice =
      typeof result === 'boolean' ? (result ? 'once' : 'deny') : result;
    return {
      approved: choice !== 'deny',
      choice,
      explanation,
      confirmationRequested: true,
      informational: false,
    };
  }
}
