/**
 * The reactive state indicator — Atlas's terminal stand-in for the particle orb.
 *
 * Design rule enforced here: animation and color are decoration only. The
 * state's plain-text label is always rendered, the indicator is always
 * readable when animation is off, and the confirmation state additionally
 * spells out that it is waiting for the user, because mistaking a safety gate
 * for a hang would be the worst failure this component could have.
 */
import React from 'react';
import { Box, Text, useAnimation, useIsScreenReaderEnabled } from 'ink';

import { tint, type Palette } from '../theme.js';
import type { ExecutionStatus } from '../../execution/environment.js';
import { describeState, framesFor, type AssistantState } from '../states.js';

const TICK_MS = 90;

export interface StatusBarProps {
  readonly state: AssistantState;
  readonly palette: Palette;
  readonly color: boolean;
  /** Whether animation is permitted at all (reduced motion, plain mode). */
  readonly animate: boolean;
  /** Short detail such as the command being run. */
  readonly detail?: string;
  /**
   * The isolation actually in force.
   *
   * Rendered as text, always, for the same reason the state label is: a
   * colour or an icon alone would leave a screen-reader user unable to tell a
   * sandboxed session from an unsandboxed one.
   */
  readonly protection?: ExecutionStatus | undefined;
}

export function StatusBar({
  state,
  palette,
  color,
  animate,
  detail,
  protection,
}: StatusBarProps): React.JSX.Element {
  const descriptor = describeState(state);
  const screenReader = useIsScreenReaderEnabled();
  // Motion is off for screen readers, reduced motion, or an explicit opt-out.
  const motion = animate && !screenReader;
  const { frame } = useAnimation({ interval: TICK_MS, isActive: motion });

  const frames = framesFor(state);
  const glyph = motion ? frames[frame % frames.length] : frames[0];

  // Computed once, not twice: the previous version called `protectionLine`
  // again in the render, and the `!== undefined` guard recomputed the string.
  const protectionText = protectionLine(protection);

  const tone = (): string | undefined => {
    if (!color) return undefined;
    if (descriptor.tone === 'warn') return palette.caution;
    if (descriptor.tone === 'accent') return palette.particle;
    return palette.inkDim;
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text {...tint(tone())}>{glyph} </Text>
        {/* Always rendered: state is never communicated by the glyph alone. */}
        <Text bold {...tint(tone())}>
          {descriptor.label}
        </Text>
        {descriptor.awaitsUser ? (
          <Text {...tint(color ? palette.caution : undefined)}>
            {' '}
            — needs your answer
          </Text>
        ) : null}
        {detail !== undefined && detail !== '' ? (
          <Text {...tint(color ? palette.inkFaint : undefined)}>
            {truncate(detail)}
          </Text>
        ) : null}
      </Box>
      {protectionText !== undefined && protection !== undefined ? (
        // Persistent: the protection in force does not change per turn, so it
        // stays on screen rather than appearing only while something runs.
        // Truncated because `writableRoots` grows with every durable grant, and
        // an untruncated line wraps and shoves the composer down on re-render.
        // `protectionLine` already caps the writable list, so the tail that
        // matters - network and seccomp - is never what gets cut.
        <Text {...tint(color && !protection.sandboxed ? palette.caution : color ? palette.inkFaint : undefined)}>
          {truncate(protectionText, 100)}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * The protection summary, phrased as what it IS rather than how it works.
 *
 * Unsandboxed gets the word "UNSANDBOXED" rather than a reassuring one,
 * because the whole point of showing this is that a user who cannot see the
 * boundary will assume there isn't one.
 */
function protectionLine(
  protection: ExecutionStatus | undefined,
): string | undefined {
  if (protection === undefined) return undefined;
  if (!protection.sandboxed) {
    // "UNSANDBOXED" rather than a reassuring word, because the whole point of
    // showing this is that a user who cannot see the boundary will assume there
    // is not one.
    const why = protection.degradedReason ? ` — ${protection.degradedReason}` : '';
    return `UNSANDBOXED (${protection.backend}): no isolation.${why}`;
  }
  const roots = protection.writableRoots;
  // Cap the list rather than truncating the whole line: a long `writableRoots`
  // used to push `network` and `seccomp` off the end, and those are the two
  // fields a user most needs to see.
  const writable =
    roots.length === 0
      ? 'nothing writable'
      : roots.length <= 2
        ? `writable: ${roots.join(', ')}`
        : `writable: ${roots[0]}, ${roots[1]}, +${roots.length - 2} more`;
  return `  sandbox: ${protection.backend} | ${protection.profile} | ${writable} | network ${protection.networkEnabled ? 'on' : 'off'} | seccomp ${protection.seccomp ? 'on' : 'off'}`;
}

function truncate(text: string, max = 58): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
