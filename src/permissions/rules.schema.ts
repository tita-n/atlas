import { z } from 'zod';

/** Risk tiers used by the shell permission gate. */
export const riskTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

/** A numeric risk tier. */
export type RiskTier = z.infer<typeof riskTierSchema>;

/** The action a matching rule requests from the harness. */
export const permissionDecisionSchema = z.enum(['deny', 'ask', 'allow']);

/** A permission decision. */
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

/** One glob-style permission rule. */
/**
 * What kind of thing a rule flags.
 *
 * Closed vocabulary on purpose: a free-text label would let a rule be filed
 * under a scope the user never approved. `secrets` is separate from
 * `filesystem` specifically so that approving filesystem changes cannot silently
 * permit reading credentials.
 */
export const riskCategorySchema = z.enum([
  'filesystem',
  'secrets',
  'network',
  'services',
  'packages',
  'processes',
  'vcs',
  'atlas-self',
]);

/** A typed risk category. */
export type RiskCategory = z.infer<typeof riskCategorySchema>;

export const permissionRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    pattern: z.string().trim().min(1).max(500),
    decision: permissionDecisionSchema,
    tier: riskTierSchema,
    description: z.string().trim().min(1).max(300),
    /**
     * Optional label for scoped approval.
     *
     * Absent means uncategorised, which is treated as out of scope and still
     * asks. Absent is the safe default, so a rule nobody has classified keeps
     * the old behaviour rather than gaining a silent exemption.
     */
    category: riskCategorySchema.optional(),
  })
  .strict();

/** A typed permission rule. */
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

/** A durable grant for one exact executable and argv shape. */
export const permissionGrantSchema = z
  .object({
    id: z.string().uuid(),
    executablePath: z.string().min(1).max(4096),
    argv: z.array(z.string()).max(256),
    cwd: z.string().min(1).max(4096),
    createdAt: z.string().datetime(),
  })
  .strict();

/** A typed durable permission grant. */
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

/** Shape of the user-editable permissions file. */
export const permissionConfigSchema = z
  .object({
    rules: z.array(permissionRuleSchema).max(500),
    grants: z.array(permissionGrantSchema).max(1000).default([]),
    confirmationPhrase: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** User-editable permission configuration. */
export type PermissionConfigFile = z.infer<typeof permissionConfigSchema>;
