import { z } from 'zod';

/** Provider wire formats supported by Atlas. */
export const providerNameSchema = z.enum([
  'openai-compatible',
  'anthropic-compatible',
]);

/** A provider identifier accepted by Atlas. */
export type ProviderName = z.infer<typeof providerNameSchema>;

const httpUrlSchema = z
  .string()
  .url('must be a valid URL')
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must use the http or https protocol');

/** Default API roots for the built-in provider implementations. */
export const DEFAULT_BASE_URLS: Readonly<Record<ProviderName, string>> = {
  'openai-compatible': 'https://api.openai.com/v1',
  'anthropic-compatible': 'https://api.anthropic.com/v1',
};

/** Configuration values accepted from a file, environment, or CLI. */
export const configOverridesSchema = z
  .object({
    provider: providerNameSchema,
    apiKey: z.string().min(1),
    baseUrl: httpUrlSchema,
    model: z.string().trim().min(1),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .partial()
  .strict();

/** Complete, validated Atlas configuration. */
export const atlasConfigSchema = z
  .object({
    provider: providerNameSchema,
    apiKey: z.string().min(1),
    baseUrl: httpUrlSchema,
    model: z.string().trim().min(1),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

/** Partial configuration values accepted by programmatic callers. */
export type ConfigOverrides = z.infer<typeof configOverridesSchema>;

/** Complete configuration consumed by providers and conversations. */
export type AtlasConfig = z.infer<typeof atlasConfigSchema>;
