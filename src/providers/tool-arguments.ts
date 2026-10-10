import { ProviderResponseError } from '../errors.js';
import type { ToolCall } from './provider.interface.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Decodes OpenAI-style JSON tool arguments into a typed record. */
export function decodeToolArguments(
  value: string,
  providerName: string,
): Record<string, unknown> {
  if (value.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error('arguments are not an object');
    return parsed;
  } catch (error) {
    throw new ProviderResponseError(
      providerName,
      'tool call arguments are not a JSON object',
      { cause: error },
    );
  }
}

/** Validates an Anthropic-style tool input object. */
export function validateToolInput(
  value: unknown,
  providerName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderResponseError(
      providerName,
      'tool call input is not an object',
    );
  }
  return value;
}

/** Type guard for a decoded tool call array item. */
export function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.arguments)
  );
}
