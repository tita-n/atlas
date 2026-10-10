/**
 * Atlas terminal theme: a red-particle palette shared by every TUI component.
 *
 * The goal is that the terminal and the eventual browser UI read as the same
 * product, so the particle red lives here once and nowhere else.
 *
 * Color is never load-bearing. Every color here has a plain-text counterpart
 * (see `stateLabel` in states.ts and the `label` fields on panels), so when
 * color is unavailable the interface still conveys the same information. This
 * module resolves to the monochrome palette rather than throwing or emitting
 * escape codes when color cannot be used.
 */

/** The particle red the GUI orb uses, and the accent Atlas inherits. */
const PARTICLE = '#ff2b3d';
const PARTICLE_DIM = '#8f1622';
const PARTICLE_BRIGHT = '#ff6b78';

/** Neutral ramp used for panels, borders, and secondary text. */
const INK = '#e6e6ea';
const INK_DIM = '#9a9aa5';
const INK_FAINT = '#5c5c66';
const SURFACE = '#1a1a1f';
const SURFACE_RAISED = '#24242b';

/** Semantic accents, tuned to stay legible on SURFACE. */
const DANGER = '#ff5c5c';
const CAUTION = '#ffb347';
const SUCCESS = '#4ade80';
const INFO = '#6aa9ff';

export interface Palette {
  readonly particle: string;
  readonly particleDim: string;
  readonly particleBright: string;
  readonly ink: string;
  readonly inkDim: string;
  readonly inkFaint: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly danger: string;
  readonly caution: string;
  readonly success: string;
  readonly info: string;
}

const COLOR_PALETTE: Palette = {
  particle: PARTICLE,
  particleDim: PARTICLE_DIM,
  particleBright: PARTICLE_BRIGHT,
  ink: INK,
  inkDim: INK_DIM,
  inkFaint: INK_FAINT,
  surface: SURFACE,
  surfaceRaised: SURFACE_RAISED,
  danger: DANGER,
  caution: CAUTION,
  success: SUCCESS,
  info: INFO,
};

/**
 * Monochrome stand-in. Every slot is present so components never branch on
 * which palette they got; the ink ramp simply collapses toward plain text.
 */
const MONOCHROME_PALETTE: Palette = {
  particle: 'white',
  particleDim: 'gray',
  particleBright: 'white',
  ink: 'white',
  inkDim: 'gray',
  inkFaint: 'gray',
  surface: 'black',
  surfaceRaised: 'black',
  danger: 'red',
  caution: 'yellow',
  success: 'green',
  info: 'cyan',
};

export interface ThemeOptions {
  /** Overrides detection; defaults to the real environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Force-disable color regardless of the environment. */
  readonly noColor?: boolean;
  /** Overrides TTY detection, which decides whether color can be emitted. */
  readonly isTTY?: boolean;
}

/**
 * Decides whether color may be emitted.
 *
 * Honors the NO_COLOR convention and TERM=dumb because both are how a user or
 * a constrained terminal says "do not colorize me". Returning the monochrome
 * palette is a supported mode, not a failure mode.
 */
export function colorEnabled(options: ThemeOptions = {}): boolean {
  if (options.noColor === true) return false;
  const env = options.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  if (options.isTTY !== undefined) return options.isTTY;
  return process.stdout.isTTY ?? false;
}

export function resolvePalette(options: ThemeOptions = {}): Palette {
  return colorEnabled(options) ? COLOR_PALETTE : MONOCHROME_PALETTE;
}

/** Resolves a palette plus the color mode, so callers can branch once. */
export function resolveTheme(options: ThemeOptions = {}): {
  palette: Palette;
  color: boolean;
} {
  const color = colorEnabled(options);
  return { palette: color ? COLOR_PALETTE : MONOCHROME_PALETTE, color };
}

/**
 * Builds a conditional `color` prop.
 *
 * The project compiles with `exactOptionalPropertyTypes`, so `color={maybe}`
 * where `maybe` can be `undefined` is a type error. Spreading this instead
 * omits the prop entirely when there is no color to apply.
 */
export function tint(color: string | undefined): { color?: string } {
  return color === undefined ? {} : { color };
}

/**
 * A short status word for a state.
 *
 * This exists so the status indicator can never rely on color alone: the word
 * is always rendered, and animation is layered on top of it rather than
 * replacing it.
 */
export type StatusWord =
  'IDLE' | 'THINKING' | 'RUNNING' | 'CONFIRM' | 'ANSWERING';

const STATUS_WORDS: Readonly<Record<string, StatusWord>> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  executing: 'RUNNING',
  'awaiting-confirmation': 'CONFIRM',
  streaming: 'ANSWERING',
};

export function statusWord(state: string): StatusWord {
  return STATUS_WORDS[state] ?? 'IDLE';
}
