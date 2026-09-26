import { z } from 'zod';

/** Permission decision recorded in the append-only audit table. */
export const auditDecisionSchema = z.enum([
  'allowed',
  'asked-approved',
  'asked-denied',
  'blocked',
]);

/** Audit decision type. */
export type AuditDecision = z.infer<typeof auditDecisionSchema>;

/** One immutable shell-attempt record. */
export const auditEntryInputSchema = z.object({
  timestamp: z.string().datetime(),
  command: z.string(),
  riskTier: z.number().int().min(0).max(3),
  matchedRule: z.string().min(1),
  decision: auditDecisionSchema,
  outcome: z.string().min(1),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

/** Validated input for appending an audit entry. */
export type AuditEntryInput = z.infer<typeof auditEntryInputSchema>;

/** Query filters for recent audit entries. */
export interface AuditQuery {
  /** Optional risk-tier filter. */
  tier?: 0 | 1 | 2 | 3 | undefined;
  /** Optional ISO timestamp lower bound. */
  since?: string | undefined;
  /** Maximum rows to return. */
  limit?: number | undefined;
}
