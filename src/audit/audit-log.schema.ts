import { z } from 'zod';

/** Permission decision recorded in the append-only audit table. */
export const auditDecisionSchema = z.enum([
  'allowed',
  'asked-approved',
  'asked-denied',
  'blocked',
  /** Shown to the user, never run. Recorded so previews leave a trace. */
  'previewed',
]);

/** Audit decision type. */
export type AuditDecision = z.infer<typeof auditDecisionSchema>;

/**
 * Which permission path produced a decision.
 *
 * `text-safe-word` is the interim, weaker path used while voice is paused. It
 * is recorded explicitly so the period during which the gate accepted a typed
 * word with no voice verification is visible after the fact.
 */
export const gatePathSchema = z.enum([
  'text-safe-word',
  'voice-paired',
  'hard-block',
  'auto-allow',
]);

export type GatePath = z.infer<typeof gatePathSchema>;

/** What kind of thing was audited. */
export const auditEventKindSchema = z.enum([
  'command',
  /** Reserved: self-modification is not implemented yet. */
  'self-modification',
]);

export type AuditEventKind = z.infer<typeof auditEventKindSchema>;

/** Outcome of the attempt, independent of how it was decided. */
export const auditOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'denied',
  /** Previewed but deliberately not executed. */
  'previewed-only',
]);

export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/**
 * One immutable audit record.
 *
 * The gate path is not optional for a decision that mattered. A dangerous
 * command approved during the interim typed-safe-word period must say so, or
 * the period cannot be reviewed after the fact. A preview deliberately carries
 * no gate path: previews bypass the gate by design.
 */
export const auditEntryInputSchema = z
  .object({
    timestamp: z.string().datetime(),
    /** Optional at the call site; defaults to a command execution. */
    eventKind: auditEventKindSchema.optional(),
    command: z.string(),
    /** Plain-language description; absent when none was generated. */
    summary: z.string().nullable().optional(),
    /** Which gate path decided it; absent when not applicable. */
    gatePath: gatePathSchema.nullable().optional(),
    /**
     * Autonomy level in force when this was recorded.
     *
     * This is what makes an unattended run reviewable afterwards: without it a
     * row written while Atlas worked unsupervised is indistinguishable from one
     * written while the user watched every prompt.
     */
    autonomy: z
      .enum(['confirm-everything', 'scoped-approval', 'unattended'])
      .nullable()
      .optional(),
    riskTier: z.number().int().min(0).max(3),
    matchedRule: z.string().min(1),
    decision: auditDecisionSchema,
    outcome: auditOutcomeSchema,
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  })
  .superRefine((entry, context) => {
    const gatePath = entry.gatePath ?? null;
    if (entry.decision === 'previewed') {
      // A preview never consulted the gate, so attributing a gate path to it
      // would be a fabrication.
      if (gatePath !== null) {
        context.addIssue({
          code: 'custom',
          path: ['gatePath'],
          message: 'A previewed entry must not carry a gate path.',
        });
      }
      return;
    }
    if (gatePath === null) {
      context.addIssue({
        code: 'custom',
        path: ['gatePath'],
        message: `A '${entry.decision}' entry must record the gate path that decided it.`,
      });
      return;
    }
    if (entry.decision === 'allowed' && gatePath !== 'auto-allow') {
      context.addIssue({
        code: 'custom',
        path: ['gatePath'],
        message:
          "An 'allowed' entry that did not ask must record the auto-allow path.",
      });
    }
  });

/** Validated input for appending an audit entry. */
export type AuditEntryInput = z.infer<typeof auditEntryInputSchema>;

/** Autonomy level recorded on an audit row. */
export type AutonomyLevelName =
  'confirm-everything' | 'scoped-approval' | 'unattended';

/** Query filters for audit entries. */
export interface AuditQuery {
  /** Optional risk-tier filter. */
  tier?: 0 | 1 | 2 | 3 | undefined;
  /** Optional ISO timestamp lower bound. */
  since?: string | undefined;
  /** Optional ISO timestamp upper bound. */
  until?: string | undefined;
  /** Optional outcome filter. */
  outcome?: AuditOutcome | undefined;
  /** Optional gate-path filter, e.g. only interim text approvals. */
  gatePath?: GatePath | undefined;
  /** Optional event-kind filter. */
  eventKind?: AuditEventKind | undefined;
  /** Optional autonomy-level filter, e.g. only unattended actions. */
  autonomy?: AutonomyLevelName | undefined;
  /** Maximum rows to return. */
  limit?: number | undefined;
}
