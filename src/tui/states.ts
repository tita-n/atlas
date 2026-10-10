/**
 * The Atlas assistant's interface states.
 *
 * These names are deliberately shared vocabulary with the eventual browser
 * orb, so the two interfaces cannot drift into unrelated state machines. Any
 * new state added here needs a matching visual in the orb work later.
 *
 * Every state carries a plain-text `label` and a `hint`, because the interface
 * must stay fully usable with color and animation switched off.
 */

export type AssistantState =
  /** Ready for input. */
  | 'idle'
  /** A request is in flight and no tool has run yet. */
  | 'thinking'
  /** A shell tool is running right now. */
  | 'executing'
  /** The dangerous-command gate is open, waiting on the user. */
  | 'awaiting-confirmation'
  /** The reply is being revealed. */
  | 'streaming';

export interface StateDescriptor {
  readonly state: AssistantState;
  /** Always rendered, so state is never conveyed by color alone. */
  readonly label: string;
  /** Longer description, shown in the help/status detail line. */
  readonly hint: string;
  /** Whether this state is animated. Purely decorative. */
  readonly animated: boolean;
  /**
   * Whether the user is being asked to do something. Only these states block
   * input, so the composer knows when to stay quiet.
   */
  readonly awaitsUser: boolean;
  /**
   * Palette role. `accent` is the particle red, `warn` is reserved for the
   * safety-critical confirmation state so it can never be confused with
   * ordinary progress.
   */
  readonly tone: 'neutral' | 'accent' | 'warn';
}

const DESCRIPTORS: Readonly<Record<AssistantState, StateDescriptor>> = {
  idle: {
    state: 'idle',
    label: 'IDLE',
    hint: 'Ready when you are.',
    animated: true,
    awaitsUser: false,
    tone: 'neutral',
  },
  thinking: {
    state: 'thinking',
    label: 'THINKING',
    hint: 'Working on it.',
    animated: true,
    awaitsUser: false,
    tone: 'accent',
  },
  executing: {
    state: 'executing',
    label: 'RUNNING',
    hint: 'Running a command on this machine.',
    animated: true,
    awaitsUser: false,
    tone: 'accent',
  },
  'awaiting-confirmation': {
    state: 'awaiting-confirmation',
    label: 'CONFIRM',
    hint: 'Waiting for you to approve or cancel a command.',
    animated: true,
    awaitsUser: true,
    tone: 'warn',
  },
  streaming: {
    state: 'streaming',
    label: 'ANSWERING',
    hint: 'Answering.',
    animated: true,
    awaitsUser: false,
    tone: 'accent',
  },
};

export function describeState(state: AssistantState): StateDescriptor {
  return DESCRIPTORS[state];
}

/** All states, in the order they normally occur in a turn. */
export const ASSISTANT_STATES: readonly AssistantState[] = [
  'idle',
  'thinking',
  'executing',
  'awaiting-confirmation',
  'streaming',
];

/**
 * Which states may follow which.
 *
 * A transition that is not permitted is a bug in whoever is driving the state
 * machine, so this is enforced rather than documented: a blocked transition
 * leaves the state unchanged instead of silently accepting nonsense.
 */
const ALLOWED: Readonly<Record<AssistantState, readonly AssistantState[]>> = {
  idle: ['thinking'],
  thinking: ['executing', 'streaming', 'idle'],
  executing: ['thinking', 'awaiting-confirmation', 'streaming', 'idle'],
  'awaiting-confirmation': ['executing', 'streaming', 'idle'],
  streaming: ['idle'],
};

/**
 * Every state named as a transition target.
 *
 * Exported so a test can assert the vocabulary stays in step with the union
 * above; not part of the UI's API.
 */
export const ALLOWED_STATES_FOR_TEST: readonly AssistantState[] = [
  ...new Set(Object.values(ALLOWED).flat()),
];

export function canTransition(
  from: AssistantState,
  to: AssistantState,
): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

export interface TransitionResult {
  readonly state: AssistantState;
  /** False when the transition was rejected and state was left alone. */
  readonly accepted: boolean;
}

export function transition(
  from: AssistantState,
  to: AssistantState,
): TransitionResult {
  if (!canTransition(from, to)) return { state: from, accepted: false };
  return { state: to, accepted: true };
}

/**
 * Frames for the reactive indicator.
 *
 * A braille orbit reads as a particle rather than a spinner, which is what the
 * browser orb is going to look like. Animation is decoration; every frame set
 * degrades to the static label when motion is off.
 */
export const IDLE_FRAMES = ['·', '•', '●', '•'] as const;
export const BUSY_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;
export const CONFIRM_FRAMES = ['!', '?', '!', '?'] as const;

export function framesFor(state: AssistantState): readonly string[] {
  if (state === 'idle') return IDLE_FRAMES;
  if (state === 'awaiting-confirmation') return CONFIRM_FRAMES;
  return BUSY_FRAMES;
}
