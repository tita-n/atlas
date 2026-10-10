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
}

export function StatusBar({
  state,
  palette,
  color,
  animate,
  detail,
}: StatusBarProps): React.JSX.Element {
  const descriptor = describeState(state);
  const screenReader = useIsScreenReaderEnabled();
  // Motion is off for screen readers, reduced motion, or an explicit opt-out.
  const motion = animate && !screenReader;
  const { frame } = useAnimation({ interval: TICK_MS, isActive: motion });

  const frames = framesFor(state);
  const glyph = motion ? frames[frame % frames.length] : frames[0];

  const tone = (): string | undefined => {
    if (!color) return undefined;
    if (descriptor.tone === 'warn') return palette.caution;
    if (descriptor.tone === 'accent') return palette.particle;
    return palette.inkDim;
  };

  return (
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
  );
}

function truncate(text: string, max = 58): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
