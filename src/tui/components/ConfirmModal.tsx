/**
 * The dangerous-command confirmation.
 *
 * Replaces typing a safe word with a single keypress, and shows the exact
 * command that will run rather than a bare "proceed?". With two options, y/n
 * is enough; with more, arrows select, so no accidental keystroke can approve
 * or deny the wrong action.
 *
 * The permission decision itself is not made here. This component only decides
 * what the user is asked and collects the answer.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { tint, type Palette } from '../theme.js';
import { Modal } from './Modal.js';

export interface ConfirmationChoice {
  readonly label: string;
  /** Short key hint shown next to the label, e.g. "y". */
  readonly key: string;
  readonly value: string;
  /** Approving runs the command; denying is the safe default. */
  readonly approving: boolean;
}

export const DEFAULT_CHOICES: readonly ConfirmationChoice[] = [
  { label: 'Run it', key: 'y', value: 'approve', approving: true },
  { label: 'Cancel', key: 'n', value: 'deny', approving: false },
];

export interface ConfirmModalProps {
  readonly palette: Palette;
  readonly color: boolean;
  /** The action being approved, shown verbatim. */
  readonly command: string;
  /** Why confirmation is required, when known. */
  readonly reason?: string;
  readonly choices?: readonly ConfirmationChoice[];
  readonly onChoose: (value: string) => void;
}

export function ConfirmModal({
  palette,
  color,
  command,
  reason,
  choices = DEFAULT_CHOICES,
  onChoose,
}: ConfirmModalProps): React.JSX.Element {
  const multiple = choices.length > 2;
  // The highlight starts on the safe option. A reflexive Enter must cancel,
  // never run something destructive, so approval always requires a deliberate
  // press of its own key.
  const safeIndex = Math.max(
    0,
    choices.findIndex((choice) => !choice.approving),
  );
  const [index, setIndex] = useState(safeIndex);

  useInput((value, key) => {
    if (key.escape) {
      // Escape always cancels: there must be a way out that cannot approve.
      const deny = choices.find((choice) => !choice.approving) ?? choices[0];
      if (deny !== undefined) onChoose(deny.value);
      return;
    }
    if (multiple && (key.upArrow || key.downArrow)) {
      setIndex((previous) =>
        key.upArrow
          ? (previous - 1 + choices.length) % choices.length
          : (previous + 1) % choices.length,
      );
      return;
    }
    const pressed = value.toLowerCase();
    const match = choices.find(
      (choice) => choice.key.toLowerCase() === pressed,
    );
    if (match !== undefined) {
      onChoose(match.value);
      return;
    }
    if (key.return && multiple) {
      const selected = choices[index];
      if (selected !== undefined) onChoose(selected.value);
      return;
    }
    if (key.return && !multiple) {
      // Enter takes the highlighted option, which starts on cancel. It can
      // therefore refuse a command, but never approve one.
      const selected = choices[index];
      if (selected !== undefined) onChoose(selected.value);
    }
  });

  return (
    <Modal
      title="confirm before running"
      tone="warn"
      palette={palette}
      color={color}
      footer={
        multiple
          ? '↑↓ choose · enter select · esc cancel'
          : 'y run it · n cancel · esc cancel'
      }
    >
      {reason === undefined ? null : (
        <Box marginBottom={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>{reason}</Text>
        </Box>
      )}
      {/* The command itself, shown verbatim and wrapped, so the user approves
          the thing that will actually run. */}
      <Box
        flexDirection="column"
        borderStyle="single"
        {...(color ? { borderColor: palette.inkFaint } : {})}
        paddingX={1}
      >
        <Text bold {...tint(color ? palette.ink : undefined)}>
          $ {command}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, choiceIndex) => {
          const selected = choiceIndex === index;
          return (
            <Text
              key={choice.value}
              bold={selected}
              {...tint(
                color
                  ? choice.approving
                    ? palette.particle
                    : palette.inkDim
                  : undefined,
              )}
            >
              {selected ? '❯ ' : '  '}
              {choice.label}
              <Text {...tint(color ? palette.inkFaint : undefined)}>
                {'  ('}
                {choice.key}
                {')'}
              </Text>
            </Text>
          );
        })}
      </Box>
    </Modal>
  );
}
