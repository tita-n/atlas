/**
 * A completed or in-flight turn in the scrollback.
 *
 * Narration and detail are rendered as separate visual regions with separate
 * prefixes, which is what lets a reader tell at a glance which is which:
 * narration is plain wrapped prose, detail is a bordered panel.
 */
import React from 'react';
import { Box, Text } from 'ink';

import { tint, type Palette } from '../theme.js';
import { DetailPanel } from './DetailPanel.js';

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
}

export interface TranscriptTurnProps {
  readonly turn: TurnView;
  readonly palette: Palette;
  readonly color: boolean;
  readonly detailExpanded: boolean;
  readonly onToggleDetail: () => void;
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
  detailExpanded,
  onToggleDetail,
  hideUser = false,
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

      {turn.detail !== '' ? (
        <DetailPanel
          detail={turn.detail}
          palette={palette}
          color={color}
          expanded={detailExpanded}
          onToggle={onToggleDetail}
        />
      ) : null}
    </Box>
  );
}
