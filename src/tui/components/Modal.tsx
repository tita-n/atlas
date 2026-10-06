/**
 * A modal overlay frame.
 *
 * Modals are the structural change in this rebuild: a decision that needs an
 * answer gets a surface of its own rather than a line in a scrollback, so it
 * cannot be scrolled past and mistaken for something Atlas said.
 *
 * The border and the header carry the modal's meaning, not colour, so the
 * distinction survives with colour disabled.
 */
import React from 'react';
import { Box, Text } from 'ink';

import { tint, type Palette } from '../theme.js';

export interface ModalProps {
  readonly title: string;
  readonly palette: Palette;
  readonly color: boolean;
  readonly children: React.ReactNode;
  /** Warns that the modal is blocking, e.g. before a dangerous command. */
  readonly tone?: 'neutral' | 'warn';
  readonly footer?: string;
}

export function Modal({
  title,
  palette,
  color,
  children,
  tone = 'neutral',
  footer,
}: ModalProps): React.JSX.Element {
  const accent =
    tone === 'warn' ? palette.caution : color ? palette.particle : undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(accent === undefined ? {} : { borderColor: accent })}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold {...tint(accent)}>
          {title}
        </Text>
        {tone === 'warn' ? (
          <Text {...tint(color ? palette.caution : undefined)}>
            {'  blocking'}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
      {footer === undefined ? null : (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.inkFaint : undefined)}>{footer}</Text>
        </Box>
      )}
    </Box>
  );
}
