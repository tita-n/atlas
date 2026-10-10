/**
 * The Atlas wordmark, shown once at startup.
 *
 * Rendered as block characters so it needs no image support, and it carries a
 * text label ("ATLAS") rather than relying on the glyphs being readable, so the
 * splash still identifies the app when the gradient is unavailable.
 */
import React from 'react';
import { Box, Text } from 'ink';

import { tint, type Palette } from '../theme.js';

export interface WordmarkProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly subtitle?: string;
}

/** The block-letter "ATLAS" wordmark. */
const GLYPHS = [
  '█▀▀ █▀▀ █▄ █   █▀▀',
  '█▄▄ █▄▄ █ ▀█   █▄▄',
  '▀  ▀ █  █ █  █ █  ▀',
] as const;

export function Wordmark({
  palette,
  color,
  subtitle = 'personal assistant',
}: WordmarkProps): React.JSX.Element {
  const ink = (line: string, index: number): React.JSX.Element => (
    <Text key={line} {...tint(color ? palette.particle : undefined)}>
      {line}
      {index === GLYPHS.length - 1 ? '' : '\n'}
    </Text>
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* The text name is always present, so the wordmark is identifiable
          even if the block glyphs do not render. */}
      <Text bold {...tint(color ? palette.ink : undefined)}>
        ATLAS
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {GLYPHS.map(ink)}
      </Box>
      <Box marginTop={1}>
        <Text {...tint(color ? palette.inkDim : undefined)}>
          {subtitle}
          <Text {...tint(color ? palette.inkFaint : undefined)}>
            {'  ·  '}
            run atlas chat for plain text
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
