/**
 * The narration / execution boundary.
 *
 * The standing rule is that reasoning, tool calls, and code are never spoken,
 * only short narration like "adding that now". Text mode currently shows more
 * than voice would, so that separation is built explicitly here: the ledger
 * records what was executed, and rendering produces a conversational narration
 * plus a clearly separated detail block. Voice integration then becomes "stop
 * displaying the detail block" rather than a rewrite.
 */
import type { ToolCall } from '../providers/provider.interface.js';

/** One recorded tool invocation and its result. */
export interface ExecutionRecord {
  readonly toolName: string;
  /** The command or arguments the model asked for. */
  readonly command: string;
  readonly ok: boolean;
  /** Short one-line outcome, safe to narrate. */
  readonly summary: string;
  /** Full output, only ever shown in the detail block. */
  readonly detail: string;
  readonly durationMs: number;
}

/** Records tool activity for one turn. */
export class ExecutionLedger {
  readonly #records: ExecutionRecord[] = [];

  /** Everything executed during the turn, in order. */
  public get records(): readonly ExecutionRecord[] {
    return this.#records;
  }

  /** Whether anything was executed. */
  public get hasWork(): boolean {
    return this.#records.length > 0;
  }

  /** Adds one execution. */
  public add(record: ExecutionRecord): void {
    this.#records.push(record);
  }

  /**
   * A short, speakable description of what happened.
   *
   * Deliberately excludes command text, output, and any reasoning: this is the
   * only part a voice would read.
   */
  public narrate(): string {
    if (this.#records.length === 0) return '';
    const failed = this.#records.filter((record) => !record.ok).length;
    const done = this.#records.length - failed;
    if (done === 0) return 'That did not work.';
    if (failed === 0) {
      return done === 1 ? 'Done.' : `Done, ${done} steps.`;
    }
    if (done === 0) return 'That did not work.';
    return `Done, ${done} of ${this.#records.length} steps.`;
  }

  /**
   * The detail block: commands and output the user did not ask to narrate.
   *
   * Rendered separately from the conversation so the boundary is visible even
   * before any text mode exists to hide it.
   */
  public detailBlock(): string {
    if (this.#records.length === 0) return '';
    const lines: string[] = [];
    for (const record of this.#records) {
      lines.push(`$ ${record.command}`);
      lines.push(record.detail.trimEnd());
      if (!record.ok) lines.push('(did not succeed)');
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  public reset(): void {
    this.#records.length = 0;
  }
}

const TOOL_PAYLOAD_KEYS = new Set([
  'tool_calls',
  'tool_call_id',
  'arguments',
  'function',
  'name',
  'input',
]);

/** Removes top-level JSON objects that look like a tool payload. */
function stripJsonPayloads(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '{') {
      out += text[index] ?? '';
      index += 1;
      continue;
    }
    const end = matchBraces(text, index);
    if (end === -1) {
      out += text.slice(index);
      break;
    }
    const candidate = text.slice(index, end + 1);
    let isPayload = false;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        isPayload = Object.keys(parsed).some((key) =>
          TOOL_PAYLOAD_KEYS.has(key.toLowerCase()),
        );
      }
    } catch {
      isPayload = false;
    }
    if (isPayload) {
      // Replace with a space so surrounding words do not fuse together.
      out += ' ';
      index = end + 1;
      continue;
    }
    out += text.slice(index, end + 1);
    index = end + 1;
  }
  return out;
}

/** Index of the brace closing the one at `start`, or -1 when unbalanced. */
function matchBraces(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Strips anything the conversational reply must not carry.
 *
 * Models occasionally inline JSON tool arguments or reasoning markers even when
 * asked not to. This is a backstop, not a substitute for asking well.
 */
export function stripExecutionLeakage(text: string): string {
  let cleaned = text;
  // Fenced JSON blocks that look like a tool call payload.
  cleaned = cleaned.replace(/```(?:json|tool|tool_call)\b[\s\S]*?```/gi, '');
  // Inline tool payloads such as {"tool_calls": [...]} or
  // {"arguments": "{...}"}. These nest, so they are removed by scanning for
  // balanced braces rather than with a non-greedy pattern, which would stop at
  // the first closing brace and leave the tail behind.
  cleaned = stripJsonPayloads(cleaned);
  // Explicit reasoning headers the model may emit.
  cleaned = cleaned.replace(
    /^\s*(?:thinking|reasoning|chain[- ]of[- ]thought|internal monologue)\s*:.*$/gim,
    '',
  );
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/** Builds a short, speakable narration line for a tool call before it runs. */
export function narrationForCommand(command: string): string {
  const verb = firstVerb(command);
  if (verb === undefined) return 'Running that now.';
  return `${verb} now.`;
}

function firstVerb(command: string): string | undefined {
  const cleaned = command.replace(/^\s*(?:sudo|env|time|nice|command)\s+/, '');
  const match = /^([a-z]+)/i.exec(cleaned);
  const verb = match?.[1]?.toLowerCase();
  if (verb === undefined || verb === '') return undefined;
  const irregular: Record<string, string> = {
    ls: 'Listing',
    rm: 'Deleting',
    cp: 'Copying',
    mv: 'Moving',
    mkdir: 'Creating',
    chmod: 'Updating permissions on',
    df: 'Checking disk space on',
    free: 'Checking memory on',
    ps: 'Checking running processes on',
    cat: 'Reading',
    grep: 'Searching',
    find: 'Searching',
  };
  return irregular[verb] ?? `Running ${verb}`;
}

/** Tool name to a readable label for narration. */
export function describeToolCall(call: ToolCall): string {
  const command =
    typeof call.arguments.command === 'string'
      ? call.arguments.command
      : JSON.stringify(call.arguments);
  return command;
}
