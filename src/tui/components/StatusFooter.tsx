/**
 * The persistent status region.
 *
 * Always visible rather than behind a command, because the questions it
 * answers — which model am I on, how much context have I burned — are the ones
 * you want answered while the agent is working.
 *
 * When no context window is configured it shows a real token count and says the
 * window is unknown. It never shows a percentage it cannot derive.
 */
import React from 'react';
import { Box, Text } from 'ink';

import { tint, type Palette } from '../theme.js';
import { contextBar } from '../tool-blocks.js';
import { statusSegments, type SessionStats } from '../session-stats.js';

export interface StatusFooterProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly provider: string;
  readonly model: string;
  readonly stats: SessionStats;
  /** Known context window; omitted when the provider does not report one. */
  readonly contextWindow?: number | undefined;
  /** Total tokens including output, the figure a context window bounds. */
  readonly tokens?: number | undefined;
}

export function StatusFooter({
  palette,
  color,
  provider,
  model,
  stats,
  contextWindow,
  tokens,
}: StatusFooterProps): React.JSX.Element {
  const segments = statusSegments({ provider, model, stats, contextWindow });
  const total = tokens ?? stats.usage.inputTokens + stats.usage.outputTokens;
  const context = contextBar({ tokens: total, contextWindow, width: 10 });

  return (
    <Box flexDirection="column">
      {context.bar === '' ? null : (
        <Box>
          <Text {...tint(color ? palette.particle : undefined)}>
            {context.bar}
          </Text>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            {' '}
            {context.percent?.toFixed(0)}% {context.text}
          </Text>
        </Box>
      )}
      <Box>
        {segments.map((segment, position) => (
          <Text key={segment} {...tint(color ? palette.inkFaint : undefined)}>
            {position === 0 ? '' : '  ·  '}
            {segment}
          </Text>
        ))}
        <Text {...tint(color ? palette.inkFaint : undefined)}>
          {'  ·  '}
          {context.bar === '' ? context.text : context.text}
        </Text>
      </Box>
    </Box>
  );
}
