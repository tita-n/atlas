import { describe, expect, it, vi } from 'vitest';
import { ShellSession } from '../../src/shell/shell-session.js';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { ProviderNetworkError } from '../../src/errors.js';

describe('shell session cancellation', () => {
  it('kills a running command when the signal aborts', async () => {
    const session = new ShellSession();
    session.restart();
    const controller = new AbortController();

    const started = Date.now();
    const pending = session.execute('sleep 30', 60_000, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 150);

    const result = await pending;
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBe(130);
    expect(elapsed).toBeLessThan(10_000);
    session.close();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const session = new ShellSession();
    session.restart();
    const controller = new AbortController();
    controller.abort();

    const result = await session.execute('echo hi', 5_000, controller.signal);
    expect(result.exitCode).toBe(130);
    session.close();
  });

  it('leaves normal commands unaffected', async () => {
    const session = new ShellSession();
    session.restart();
    const result = await session.execute('echo hello', 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    session.close();
  });

  it('does not leave a stale listener that fires on later commands', async () => {
    const session = new ShellSession();
    session.restart();
    const controller = new AbortController();

    await session.execute('echo first', 10_000, controller.signal);
    // Aborting after the command already finished must not affect anything.
    controller.abort();
    const second = await session.execute('echo second', 10_000);

    expect(second.stdout).toContain('second');
    session.close();
  });
});

describe('provider cancellation', () => {
  it('stops an in-flight request when aborted', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 0 },
    });
    const controller = new AbortController();

    const pending = provider.chatCompletion({
      model: 'm',
      messages: [],
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(pending).rejects.toBeInstanceOf(ProviderNetworkError);
  });

  it('does not retry after a deliberate cancellation', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1',
      dependencies: { fetch: fetchMock, maxRetries: 3, retryDelayMs: 0 },
    });
    const controller = new AbortController();

    const pending = provider.chatCompletion({
      model: 'm',
      messages: [],
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(pending).rejects.toBeInstanceOf(ProviderNetworkError);
    // One deliberate cancel must not burn the retry budget.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation reporting', () => {
  it('tells the model the user cancelled rather than claiming a timeout', async () => {
    const session = new ShellSession();
    session.restart();
    const controller = new AbortController();
    const pending = session.execute('sleep 30', 60_000, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 100);

    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
    session.close();
  });
});
