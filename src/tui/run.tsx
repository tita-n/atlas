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
}

export async function runTui({
  configOptions,
  overrides,
  newConversation,
}: RunTuiOptions): Promise<void> {
  const bridge = new TuiBridge();
  const started = await createAssistantRuntime({
    configOptions,
    overrides,
    newConversation,
    requestConfirmation: bridge.requestConfirmation,
    onToolStart: bridge.observeToolStart,
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

  const color = colorEnabled();
  let instance: Instance | undefined;
  try {
    instance = render(
      <AtlasApp
        runtime={runtime}
        bridge={bridge}
        animate
        resumed={runtime.resumedConversationId !== undefined}
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
