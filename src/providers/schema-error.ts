import { z } from 'zod';
import { ProviderResponseError } from '../errors.js';

const MAX_REPORTED_ISSUES = 4;

/** Renders Zod issues as field paths plus expected types, never message content. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Builds a response error that names the offending fields instead of only
 * reporting that the payload did not match the expected schema.
 */
export function providerSchemaError(
  providerName: string,
  context: string,
  error: z.ZodError,
): ProviderResponseError {
  return new ProviderResponseError(
    providerName,
    `${context} (${describeIssues(error)})`,
  );
}
