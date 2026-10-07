/**
 * A completed or in-flight turn in the scrollback.
 *
 * Narration and tool activity are different kinds of object, not two styles of
 * text: prose is written out, and each tool call is its own block with its own
 * collapsed and expanded state. That is what makes the separation usable rather
 * than merely visible.
 */
import React from 'react';
import { Box, Text } from 'ink';

import { tint, type Palette } from '../theme.js';
import { ToolBlock, type ToolBlockView } from './ToolBlock.js';
import type { TurnToolCall } from '../../conversation/session.js';

export interface TurnView {
  /** Discriminates this from the splash when both share a scrollback array. */
  readonly kind: 'turn';
  readonly id: string;
  readonly user: string;
  /** Narration as currently revealed; may be partial while streaming. */
  readonly narration: string;
  readonly detail: string;
  /** True until the turn finishes, which dims the narration slightly. */
  readonly pending: boolean;
  /** Reasoning for this turn, shown only when the user asks for it. */
  readonly reasoning?: string | undefined;
  /** Tool calls executed during the turn, for their own blocks. */
  readonly toolCalls?: readonly TurnToolCall[] | undefined;
}

export interface TranscriptTurnProps {
  readonly turn: TurnView;
  readonly palette: Palette;
  readonly color: boolean;
  /** Rendered tool blocks for this turn. */
  readonly toolViews: readonly ToolBlockView[];
  /** Tool ids the user has expanded. */
  readonly expandedIds: ReadonlySet<string>;
  /** The tool block currently accepting a keypress; only it is interactive. */
  readonly focusedTool: string | null;
  /** Whether the user has asked to see model reasoning. */
  readonly showReasoning?: boolean;
  readonly onToggleTool: (toolId: string) => void;
  /**
   * Hides the user's line. Used for the in-flight turn in the live region:
   * the user has just typed it, and it is reprinted in scrollback when the
   * turn commits, so showing it twice reads as a duplicate.
   */
  readonly hideUser?: boolean;
}

export function TranscriptTurn({
  turn,
  palette,
  color,
  toolViews,
  expandedIds,
  focusedTool,
  onToggleTool,
  hideUser = false,
  showReasoning = false,
}: TranscriptTurnProps): React.JSX.Element {
  return (
    <Box key={turn.id} flexDirection="column" marginBottom={1}>
      {hideUser ? null : (
        <Box>
          <Text bold {...tint(color ? palette.particle : undefined)}>
            you{'  '}
          </Text>
          <Text>{turn.user}</Text>
        </Box>
      )}

      {turn.narration !== '' ? (
        <Box marginTop={1}>
          <Text
            {...tint(
              color ? (turn.pending ? palette.inkDim : palette.ink) : undefined,
            )}
          >
            {turn.narration}
            {turn.pending ? '▌' : ''}
          </Text>
        </Box>
      ) : null}

      {showReasoning &&
      turn.reasoning !== undefined &&
      turn.reasoning !== '' ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          {...(color ? { borderColor: palette.inkFaint } : {})}
          paddingX={1}
        >
          <Text {...tint(color ? palette.inkFaint : undefined)}>
            model reasoning
          </Text>
          {turn.reasoning.split('\n').map((line, index) => (
            <Text key={index} {...tint(color ? palette.inkDim : undefined)}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {toolViews.map((tool) => (
        <ToolBlock
          key={tool.id}
          call={tool}
          palette={palette}
          color={color}
          expanded={expandedIds.has(tool.id)}
          focused={focusedTool === tool.id}
          onToggle={() => {
            onToggleTool(tool.id);
          }}
        />
      ))}
    </Box>
  );
}
