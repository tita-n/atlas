/**
 * Assembles the per-turn system prompt.
 *
 * Three parts, in a fixed order: the editable personality block, the standing
 * corrections that are relevant to this turn, and the relevant durable facts.
 * Only relevant memory is injected; the whole store is never dumped.
 */

export interface SystemPromptInput {
  /** The editable personality block. */
  readonly personality: string;
  /** Corrections relevant to this turn, most relevant first. */
  readonly corrections?: readonly string[];
  /** Durable facts relevant to this turn. */
  readonly facts?: readonly string[];
  /** Instructions for the narration / execution boundary. */
  readonly narrationRule?: string;
  /** Names of the tools actually available this turn. */
  readonly availableTools?: readonly string[];
}

/**
 * The narration rule.
 *
 * This is the boundary voice will later depend on. It is stated in the prompt
 * so the model produces a narrative reply by default, rather than relying on
 * post-processing to rescue a reply that was never meant to be spoken.
 */
export const NARRATION_RULE = [
  'Reply style for this turn:',
  '- Your reply is narration addressed to the user, not a transcript.',
  '- Describe what you did and what you found, in a few short lines.',
  '- Do not include reasoning, chain-of-thought, tool-call JSON, or the',
  '  arguments you passed to a tool.',
  '- Do not paste command output or code into the reply. Say what it showed.',
  '- Raw output and code are shown to the user in a separate block, so the',
  '  user can always see them; you do not need to repeat them.',
].join('\n');

/**
 * States the real tool surface.
 *
 * Without this the model invents memory tools that do not exist and burns
 * turns calling them.
 */
function toolsSection(names: readonly string[]): string {
  if (names.length === 0) {
    return [
      'Tools:',
      '- You have no tools available right now. Answer from what you know and',
      '  from the notes above.',
    ].join('\n');
  }
  return [
    'Tools you can call:',
    `- ${names.join(', ')}`,
    '- That is the complete list. You have no other tools, and no tools for',
    '  reading or writing memory; remembering is handled automatically.',
  ].join('\n');
}

function section(title: string, lines: readonly string[]): string {
  if (lines.length === 0) return '';
  const body = lines.map((line) => `- ${line}`).join('\n');
  return `\n${title}:\n${body}`;
}

/** Builds the system prompt for one turn. */
export function buildTurnPrompt(input: SystemPromptInput): string {
  const parts: string[] = [input.personality.trim()];
  parts.push(input.narrationRule ?? NARRATION_RULE);
  parts.push(toolsSection(input.availableTools ?? []));
  parts.push(section('Corrections you must follow', input.corrections ?? []));
  parts.push(section('Known facts about the user', input.facts ?? []));
  return parts
    .filter((part) => part.trim() !== '')
    .join('\n')
    .trim();
}
