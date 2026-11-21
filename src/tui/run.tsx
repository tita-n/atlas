/**
 * Mounts the Atlas terminal interface.
 *
 * Owns three decisions the components deliberately do not make for themselves:
 *   - whether to run at all (a TUI needs an interactive terminal);
 *   - whether ANSI escapes may be emitted (NO_COLOR, TERM=dumb, non-TTY);
 *   - teardown, so the runtime's lock is always released and memory flushed.
 */
import { render, type Instance } from 'ink';

import { createAssistantRuntime } from '../conversation/assistant-runtime.js';
import type { ExecutionStatus } from '../execution/environment.js';
import { saveConfig, getDefaultConfigPath } from '../config/config.js';
import { validateApiKey } from '../providers/key-validation.js';
import type { LoadConfigOptions } from '../config/config.js';
import type { ConfigOverrides } from '../config/config.schema.js';
import { colorEnabled } from './theme.js';
import { AtlasApp } from './App.js';
import { TuiBridge } from './bridge.js';
import { canRunTui } from './can-run.js';

export { canRunTui };

/**
 * Strips ANSI SGR escapes, used when color must not be emitted at all.
 *
 * Built from an explicit escape code rather than a literal control
 * character so the pattern stays readable in source.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** A stdout-like stream that optionally strips color from everything. */
function pipedOutput(color: boolean): NodeJS.WriteStream {
  const target = process.stdout;
  if (color) return target;
  return new Proxy(target, {
    get(stream, property, receiver) {
      if (property === 'write') {
        return (chunk: unknown): boolean => {
          if (typeof chunk === 'string')
            return target.write(chunk.replace(ANSI, ''));
          return (target.write as (c: unknown) => boolean)(chunk);
        };
      }
      return Reflect.get(stream, property, receiver) as unknown;
    },
  });
}

/**
 * Everything the TUI needs from the CLI layer.
 *
 * Deliberately plain values rather than the CLI's own option interfaces, so
 * `run.tsx` never imports `cli.ts` and the two cannot form a cycle.
 */
export interface RunTuiOptions {
  /** Config path selection, as computed by the caller's `pathOptions`. */
  readonly configOptions: LoadConfigOptions;
  /** Config overrides, as computed by the caller's `compactOverrides`. */
  readonly overrides: ConfigOverrides;
  /** Start a fresh conversation instead of resuming the most recent one. */
  readonly newConversation: boolean;
  /**
   * Called once the protection in force is known.
   *
   * The TUI shows it before the first prompt. Without this the sandbox status
   * would exist only in the plain front-end, and switching front-ends would
   * hide it.
   */
  readonly onProtectionChange?: ((status: ExecutionStatus) => void) | undefined;
}

export async function runTui({
  configOptions,
  overrides,
  newConversation,
  onProtectionChange,
}: RunTuiOptions): Promise<void> {
  const bridge = new TuiBridge();
  const started = await createAssistantRuntime({
    configOptions,
    overrides,
    newConversation,
    requestConfirmation: bridge.requestConfirmation,
    onToolStart: bridge.observeToolStart,
    // Recorded on the bridge so the STATUS BAR shows it. Printing to stdout as
    // well would put raw text above the interface, which Ink redraws over -
    // so the plain front-end prints, and the TUI renders.
    onProtectionChange: (status) => {
      bridge.setProtection(status);
      // Forward, do not swallow. The previous version used the caller's
      // callback only as a truthiness gate and then never invoked it, so a
      // caller that wanted to observe the status silently got nothing.
      onProtectionChange?.(status);
    },
    // Startup notices belong inside the interface, not printed above it.
    notices: {
      line: (message) => {
        bridge.onNotice(message);
      },
      banner: (message) => {
        bridge.onNotice(message);
      },
    },
  });

  if (started.locked) {
    process.stdout.write(`${started.message}\n`);
    return;
  }
  const { runtime } = started;

  // Only shown when it is actually known: a guessed context window would make
  // the percentage a decoration rather than a measurement.
  const contextWindow = readContextWindow();
  const color = colorEnabled();
  let instance: Instance | undefined;
  try {
    instance = render(
      <AtlasApp
        runtime={runtime}
        bridge={bridge}
        animate
        resumed={runtime.resumedConversationId !== undefined}
        {...(contextWindow === undefined ? {} : { contextWindow })}
        validateKey={async ({ provider, apiKey, baseUrl, model }) => {
          // The probe hits the endpoint being configured — the models list
          // first (free, spends no tokens), a one-token completion only as
          // fallback — and answers three ways: accepted, accepted with an
          // empty account, rejected. Nothing is written until a verdict
          // arrives, so a bad key cannot leave a config file that fails on
          // the next launch. The key is never logged.
          const result = await validateApiKey({
            provider:
              provider === 'anthropic-compatible'
                ? 'anthropic-compatible'
                : 'openai-compatible',
            apiKey,
            baseUrl,
            model,
          });
          if (result.status === 'rejected') {
            return {
              ok: false,
              ...(result.message === undefined
                ? {}
                : { message: result.message }),
            };
          }
          if (result.status === 'accepted-no-balance') {
            return {
              ok: true,
              ...(result.message === undefined
                ? {}
                : { warning: result.message }),
            };
          }
          return { ok: true };
        }}
        saveConfig={async ({ provider, apiKey, model, baseUrl }) => {
          await saveConfig(
            getDefaultConfigPath(runtime.assistantConfig.homeDirectory),
            {
              ...runtime.config,
              provider: provider as typeof runtime.config.provider,
              apiKey,
              model,
              // A custom endpoint replaces the vendor default; without one the
              // existing base URL is kept so /init does not silently reroute a
              // working configuration.
              ...(baseUrl === undefined ? {} : { baseUrl }),
            },
          );
          runtime.session.setModel(model);
        }}
      />,
      { stdout: pipedOutput(color), exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
  } finally {
    // Always release the lock and drain memory, even if rendering threw.
    await runtime.close().catch(() => undefined);
    instance?.unmount();
  }
}

/**
 * Reads an explicitly configured context window.
 *
 * Providers do not report one consistently, so Atlas has none by default. An
 * operator who knows theirs can supply it rather than Atlas inventing one.
 */
function readContextWindow(): number | undefined {
  const raw = process.env.ATLAS_CONTEXT_WINDOW;
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
