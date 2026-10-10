/**
 * The input line.
 *
 * The prompt adapts to state so the user can tell what is expected: while a
 * confirmation is open the composer is replaced by the gate (see
 * `ConfirmationPrompt`), and while a turn is running it shows the state rather
 * than pretending input is being accepted.
 */
import React from 'react';
import { Box, Text } from 'ink';

import { tint, type Palette } from '../theme.js';
import { describeState, type AssistantState } from '../states.js';

export interface ComposerProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly state: AssistantState;
  readonly value: string;
  /** Renders as dimmed when input is not being accepted. */
  readonly enabled: boolean;
}

export function Composer({
  palette,
  color,
  state,
  value,
  enabled,
}: ComposerProps): React.JSX.Element {
  const blocked = describeState(state).awaitsUser || !enabled;
  return (
    <Box>
      <Text
        bold
        {...tint(
          !color
            ? undefined
            : describeState(state).awaitsUser
              ? palette.caution
              : palette.particle,
        )}
      >
        atlas{'  '}
      </Text>
      <Text {...tint(color && blocked ? palette.inkFaint : undefined)}>
        {value}
        {blocked ? '' : '▌'}
      </Text>
    </Box>
  );
}

export interface ConfirmationPromptProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly message: string;
  readonly phrase: string;
}

/**
 * The dangerous-command gate.
 *
 * Rendered as its own bordered panel with a warning tone and an explicit
 * instruction, so a paused-Atlas-at-a-gate never reads as a hung process.
 */
export function ConfirmationPrompt({
  palette,
  color,
  message,
  phrase,
}: ConfirmationPromptProps): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(color ? { borderColor: palette.caution } : {})}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold {...tint(color ? palette.caution : undefined)}>
          confirmation required
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{message}</Text>
      </Box>
      <Box marginTop={1}>
        <Text {...tint(color ? palette.inkDim : undefined)}>
          type{' '}
          <Text bold {...tint(color ? palette.ink : undefined)}>
            {phrase}
          </Text>{' '}
          to run it, anything else to cancel
        </Text>
      </Box>
    </Box>
  );
}
