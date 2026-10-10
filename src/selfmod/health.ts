/**
 * Startup health check and automatic rollback.
 *
 * This is the piece that makes self-modification safe to have at all. A bad
 * change can stop Atlas from starting, so "apply, then hope it works" is not an
 * option. Every applied change is followed by a health check, and a change that
 * fails health is rolled back to the last known-good snapshot without asking.
 *
 * The check is deliberately cheap and decisive rather than exhaustive: it asks
 * "can this build actually run?" - typecheck, build, and a real invocation.
 * Anything less would pass a change that has broken the entry point.
 */

export interface HealthStep {
  readonly name: string;
  /** Shell command to run, as argv. */
  readonly argv: readonly string[];
  /** Milliseconds before the step is treated as failed. */
  readonly timeoutMs: number;
}

export interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface HealthReport {
  readonly healthy: boolean;
  readonly steps: readonly StepResult[];
  /** Step that failed, when unhealthy. */
  readonly failedAt?: string | undefined;
}

/** The checks a build must pass to count as startable. */
export function healthSteps(): readonly HealthStep[] {
  return [
    {
      name: 'typecheck',
      argv: ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
      timeoutMs: 180_000,
    },
    { name: 'build', argv: ['npm', 'run', 'build'], timeoutMs: 300_000 },
    {
      // The real proof: the entry point the package exposes must still run.
      name: 'starts',
      argv: ['node', 'dist/cli.js', '--version'],
      timeoutMs: 30_000,
    },
  ];
}

/** Turns raw step output into a verdict. */
export function evaluateHealth(steps: readonly StepResult[]): HealthReport {
  const failed = steps.find((step) => !step.ok);
  return {
    healthy: failed === undefined,
    steps,
    ...(failed === undefined ? {} : { failedAt: failed.name }),
  };
}

/**
 * What to do after a health check.
 *
 * Kept separate from running it so the decision can be unit tested without a
 * toolchain, and so the policy is visible in one place.
 */
export function recoveryFor(report: HealthReport): 'accept' | 'rollback' {
  return report.healthy ? 'accept' : 'rollback';
}
