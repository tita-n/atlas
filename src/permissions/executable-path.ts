import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Path prefixes Atlas treats as system-owned for automatic safe approval. */
export const TRUSTED_PREFIXES = [
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
] as const;

/**
 * Resolves an executable name or path to a real, runnable file.
 *
 * This is deliberately weaker than {@link resolveTrustedExecutablePath}: it
 * only answers "does this resolve to a real executable file". Callers that
 * auto-approve without asking a human must additionally require a trusted
 * system prefix.
 */
export function resolveExecutablePath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = executable.includes('/')
    ? [resolve(executable)]
    : (environment.PATH ?? '')
        .split(delimiter)
        .filter((directory) => directory !== '')
        .map((directory) => join(directory, executable));

  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
      return real;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Resolves an executable that Atlas is willing to auto-approve as read-only.
 *
 * Requires a canonical path under a system-owned prefix, so a same-named
 * binary elsewhere on the machine is never trusted for automatic approval.
 */
export function resolveTrustedExecutablePath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const resolved = resolveExecutablePath(executable, environment);
  if (resolved === undefined) return undefined;
  if (!isAbsolute(resolved)) return undefined;
  return TRUSTED_PREFIXES.some(
    (prefix) => resolved === prefix.slice(0, -1) || resolved.startsWith(prefix),
  )
    ? resolved
    : undefined;
}
