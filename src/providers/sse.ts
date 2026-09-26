import { ProviderNetworkError, ProviderResponseError } from '../errors.js';

function eventData(block: string): string | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  return data === '' ? undefined : data;
}

/** Yields the `data` payload from each server-sent event in an HTTP response. */
export async function* readSseData(
  body: ReadableStream<Uint8Array> | null,
  providerName: string,
): AsyncGenerator<string> {
  if (body === null) {
    throw new ProviderResponseError(
      providerName,
      'streaming response has no body',
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseBlock = function* (block: string): Generator<string> {
    const data = eventData(block);
    if (data !== undefined) yield data;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* parseBlock(block);
        boundary = buffer.indexOf('\n\n');
      }

      if (done) break;
    }

    if (buffer.trim() !== '') {
      yield* parseBlock(buffer);
    }
  } catch (error) {
    if (
      error instanceof ProviderNetworkError ||
      error instanceof ProviderResponseError
    ) {
      throw error;
    }
    throw new ProviderNetworkError(providerName, { cause: error });
  } finally {
    // Cancel before releasing the lock. Releasing alone leaves the HTTP
    // response undrained, so a stream the consumer abandoned early (for
    // example on [DONE]) never returns its connection to the pool.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
