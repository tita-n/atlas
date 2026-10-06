/**
 * Atlas's identity, anchored structurally on every turn.
 *
 * Research on this failure is unusually specific. In an incident with a
 * persistent always-on agent, persona continuity held with zero failures while
 * the persona was re-injected at the system-prompt level every turn, and broke
 * as soon as a turn's context lacked it - notably after *automation-style*
 * turns rather than conversational ones. Continuity also depended on the kind
 * of interaction following the prompt, not on the prompt alone.
 *
 * Two consequences shaped this module:
 *
 *   1. The block is content Atlas owns. It never varies with the provider, so
 *      switching backing models needs no reconfiguration.
 *   2. The persona is referred to by name repeatedly, which is what the
 *      named-subject persona-reference work identifies as what keeps the
 *      persona salient in long sessions.
 *
 * What this is: how Atlas presents itself in conversation. What it is not: a
 * guarantee about the underlying model's trained self-knowledge. Models
 * distilled from another may carry a latent identity that prompt wording does
 * not remove, and this is deliberately not marketed as preventing that.
 */

/** The name the user talks to. Fixed, and independent of any provider. */
export const ATLAS_IDENTITY = 'Atlas';

/**
 * A direct question about what the user is talking to.
 *
 * Deliberately non-global: a `/g` regex on a module-level constant carries
 * `lastIndex` between calls and makes the result of an identical message
 * depend on which message was tested before it. Alternation is ordered
 * longest-and-most-specific first purely for readability; order does not
 * affect the boolean result.
 */
const IDENTITY_QUESTION = new RegExp(
  [
    // Direct self-reference.
    String.raw`\b(?:who\s+are\s+you|what\s+are\s+you)\b`,
    String.raw`\bwhat'?s\s+your\s+name\b`,
    // "What is this?" addressed to the agent, not to a file or an error.
    String.raw`\bwhat'?s\s+this\s*[?!]?\s*$`,
    // Identity asked as a category rather than by name.
    String.raw`\bare\s+you\s+(?:an?\s+)?(?:ai|llm|bot|chatbot|model|assistant|human)\b`,
    // Named-vendor questions. The vendor list lives here only so a direct
    // "are you Claude?" is recognised; it never reaches the prompt.
    String.raw`\bare\s+you\s+(?:claude|gpt|chatgpt|gemini|llama|copilot|grok|mistral|deepseek|qwen)\b`,
    String.raw`\b(?:what|which)\s+model\s+are\s+you\b`,
    String.raw`\b(?:what|which)\s+ai\s+are\s+you\b`,
    // Attribution.
    String.raw`\b(?:who|what)\s+(?:company\s+)?(?:made|built|created|trained)\s+you\b`,
    // Requests for a self-introduction.
    String.raw`\bintroduce\s+yourself\b`,
    String.raw`\b(?:tell\s+me\s+about\s+yourself|tell\s+me\s+what\s+you\s+are)\b`,
    String.raw`\b(?:name|identify)\s+yourself\b`,
    // Bare "your name?" as a whole message. Constrained so that instructions
    // about *renaming things* ("change your name, then run the tests") do not
    // sharpen an ordinary work turn.
    String.raw`\byour\s+name\s*[?!]?\s*$`,
  ].join('|'),
  'i',
);

/**
 * Whether a message is asking about identity directly.
 *
 * Used to sharpen the instruction, not to hardcode an answer: the model still
 * answers in its own words, but is told plainly which identity to speak from.
 */
export function isIdentityQuestion(message: string): boolean {
  if (message.trim() === '') return false;
  return IDENTITY_QUESTION.test(message);
}

/**
 * The identity block, injected into the system prompt of every turn.
 *
 * Static and provider-independent by construction - it takes no provider name,
 * no model name, and no parameters - so it cannot drift into describing
 * whichever model happens to be backing the session.
 */
export function identityBlock(): string {
  return [
    'Identity (this is authoritative for this turn):',
    `- You are ${ATLAS_IDENTITY}. That is your name and the identity you speak from.`,
    `- ${ATLAS_IDENTITY} is a personal assistant that runs on the user's own machine,`,
    "  under the user's own account.",
    `- You are not a model vendor's assistant, and you do not introduce yourself as one.`,
    '  If asked what model or AI you are, the answer is that you are Atlas.',
    '- A language model does the thinking underneath. That is the harness, not',
    '  who you are. The user is talking to Atlas either way, and this does not',
    '  change when the underlying model does.',
    "- Answer questions about yourself as Atlas, in Atlas's own voice.",
  ].join('\n');
}

export interface IdentityPromptOptions {
  /** The user's message for this turn, used to sharpen identity questions. */
  readonly userMessage?: string | undefined;
  /**
   * Whether this turn was automation-triggered rather than conversational.
   *
   * Automation turns are where the research saw identity break, so the block is
   * restated rather than merely present for them.
   */
  readonly automated?: boolean | undefined;
}

/**
 * The per-turn identity section.
 *
 * Returned fresh on every call and never cached: continuity comes from the
 * block being structurally present each turn, not from history carrying it
 * forward.
 */
export function identitySection(options: IdentityPromptOptions = {}): string {
  const parts = [identityBlock()];
  if (options.automated === true) {
    parts.push(
      [
        'This turn is automation-triggered, not a reply to the user.',
        'You are still Atlas. Non-conversational turns are where identity is',
        'most likely to drift, so answer as Atlas regardless.',
      ].join('\n'),
    );
  }
  if (
    options.userMessage !== undefined &&
    isIdentityQuestion(options.userMessage)
  ) {
    parts.push(
      [
        'The user just asked who you are. Answer as Atlas. Do not name the',
        'underlying model as your identity, and do not describe yourself as',
        "that model's assistant.",
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}
