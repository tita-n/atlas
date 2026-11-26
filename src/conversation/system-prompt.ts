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
  /** Brief planning instruction for non-trivial work; omitted otherwise. */
  readonly planningNote?: string | undefined;
  /**
   * Per-turn identity section.
   *
   * Required rather than optional on purpose: the research is unambiguous
   * that identity does not survive on conversation history alone, so this
   * cannot be something a caller may forget to pass.
   */
  readonly identity: string;
  /** Whether this turn was automation-triggered rather than conversational. */
  readonly automated?: boolean | undefined;
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
  const has = (name: string): boolean => names.includes(name);
  const lines: string[] = ['Tools you can call:', `- ${names.join(', ')}`];

  // The evaluation caught the model narrating a plan to create files and then
  // producing nothing, because nothing said these tools existed or how to use
  // them. Say it plainly rather than expecting the model to rediscover it.
  if (has('read_file')) {
    lines.push('- To READ a file, call `read_file` with its path.');
  }
  if (has('write_file')) {
    lines.push(
      '- To CREATE a file or save content, call `write_file` with the path and',
      '  the full content. Do this instead of shell redirection or a heredoc.',
    );
  }
  if (has('edit_file')) {
    lines.push(
      '- To CHANGE an existing file, call `edit_file` with the exact text to',
      '  replace and its replacement.',
    );
  }
  if (has('search_files')) {
    lines.push(
      '- To FIND files by name, or text inside them, call `search_files`',
      '  instead of shelling out to find or grep.',
    );
  }
  if (has('list_directory')) {
    lines.push('- To see what is in a directory, call `list_directory`.');
  }
  if (has('delete_file')) {
    lines.push('- To remove a file, call `delete_file`.');
  }
  if (has('shell')) {
    lines.push(
      '- Use `shell` for running commands and processes. Prefer the purpose-',
      '  built tools above for anything to do with file content.',
    );
  }
  lines.push(
    '- That is the complete list. You have no other tools, and no tools for',
    '  reading or writing memory; remembering is handled automatically.',
    '- If a task needs a file created or changed, use the tools. Do not',
    '  describe what you would do - do it.',
  );
  return lines.join('\n');
}

function section(title: string, lines: readonly string[]): string {
  if (lines.length === 0) return '';
  const body = lines.map((line) => `- ${line}`).join('\n');
  return `\n${title}:\n${body}`;
}

/** Builds the system prompt for one turn. */
export function buildTurnPrompt(input: SystemPromptInput): string {
  // Identity first, so it holds even if the editable personality is replaced.
  // The persona must be anchored structurally on every turn rather than left
  // for history to carry forward.
  const parts: string[] = [input.identity.trim(), input.personality.trim()];
  parts.push(input.narrationRule ?? NARRATION_RULE);
  parts.push(toolsSection(input.availableTools ?? []));
  parts.push(section('Corrections you must follow', input.corrections ?? []));
  parts.push(section('Known facts about the user', input.facts ?? []));
  // Present only for non-trivial turns, so short questions are unaffected.
  if (input.planningNote !== undefined && input.planningNote.trim() !== '') {
    parts.push(input.planningNote);
  }
  return parts
    .filter((part) => part.trim() !== '')
    .join('\n')
    .trim();
}
