/**
 * The `/autonomy` surface: pick a level, and pay deliberate friction to lower it.
 *
 * The asymmetry is the point. Raising the level, or keeping the default, is one
 * keypress. Lowering it shows what is being given up in a warning colour and
 * requires typing a specific phrase, because this is the one setting where a
 * slip has consequences that persist after the session ends.
 *
 * A per-task override uses the same warning but a lighter ceremony, since it is
 * scoped to one task and temporary by nature. The global default is the one
 * that deserves the ritual.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';

import { tint, type Palette } from '../theme.js';
import { Modal } from './Modal.js';
import {
  AUTONOMY_LEVELS,
  confirmationPhraseFor,
  describeLevel,
  type AutonomyLevel,
} from '../../permissions/autonomy.js';

export type AutonomyStep = 'pick' | 'confirm-global' | 'confirm-task' | 'scope';

export interface AutonomyModalProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly current: AutonomyLevel;
  readonly step: AutonomyStep;
  /** Level the user has highlighted. */
  readonly index: number;
  readonly typed: string;
  /** Declared categories for a scoped task override. */
  readonly onIndex: (index: number) => void;
  readonly onStep: (step: AutonomyStep) => void;
  readonly onTyped: (value: string) => void;
  readonly onLevel: (level: AutonomyLevel) => void;
  readonly onCancel: () => void;
  /** True when this is a one-task override rather than the global default. */
  readonly perTask?: boolean;
}

/** Categories offered for a scoped task. Kept in step with the rule vocabulary. */
export const SCOPE_CATEGORIES = [
  'filesystem',
  'packages',
  'services',
  'network',
  'vcs',
] as const;

export function AutonomyModal({
  palette,
  color,
  current,
  step,
  index,
  typed,
  onIndex,
  onStep,
  onTyped,
  onLevel,
  onCancel,
  perTask = false,
}: AutonomyModalProps): React.JSX.Element {
  useInput((value, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (step === 'pick') {
      if (key.upArrow || key.downArrow) {
        onIndex(
          key.upArrow
            ? (index - 1 + AUTONOMY_LEVELS.length) % AUTONOMY_LEVELS.length
            : (index + 1) % AUTONOMY_LEVELS.length,
        );
        return;
      }
      if (key.return) {
        const chosen = AUTONOMY_LEVELS[index];
        if (chosen === undefined) return;
        // Lowering needs the ceremony; keeping or raising the level does not.
        const isLowering =
          AUTONOMY_LEVELS.indexOf(chosen) > AUTONOMY_LEVELS.indexOf(current);
        if (isLowering && describeLevel(chosen).requiresFriction) {
          onTyped('');
          onStep(perTask ? 'confirm-task' : 'confirm-global');
          return;
        }
        onLevel(chosen);
        return;
      }
      return;
    }
    // Both confirmation steps: the phrase must be typed exactly.
    if (key.backspace || key.delete) {
      onTyped(typed.slice(0, -1));
      return;
    }
    if (key.return) {
      const target = AUTONOMY_LEVELS[index];
      if (target === undefined) return;
      if (typed.trim() === confirmationPhraseFor(target)) onLevel(target);
      else {
        onTyped('');
        onStep('pick');
      }
      return;
    }
    if (value !== '') onTyped(typed + value);
  });

  if (step === 'pick') {
    return (
      <Modal
        title={perTask ? 'autonomy for this task' : 'autonomy level'}
        palette={palette}
        color={color}
        footer="↑↓ move · enter choose · esc cancel"
      >
        {AUTONOMY_LEVELS.map((level, position) => {
          const described = describeLevel(level);
          const selected = position === index;
          const isCurrent = level === current;
          // Lowering is rendered in the warning tone; the default is calm.
          const tintColor = !color
            ? undefined
            : described.requiresFriction && selected
              ? palette.caution
              : selected
                ? palette.particle
                : palette.ink;
          return (
            <Text key={level} bold={selected} {...tint(tintColor)}>
              {selected ? '❯ ' : '  '}
              {described.label}
              {isCurrent ? '  (current)' : ''}
              <Text {...tint(color ? palette.inkFaint : undefined)}>
                {'  '}
                {described.risk}
              </Text>
            </Text>
          );
        })}
      </Modal>
    );
  }

  const target = AUTONOMY_LEVELS[index];
  if (target === undefined) return <Text />;
  const described = describeLevel(target);
  const phrase = confirmationPhraseFor(target);

  return (
    <Modal
      title={
        perTask ? 'run this task unattended?' : 'lower your safety setting?'
      }
      tone="warn"
      palette={palette}
      color={color}
      footer={
        perTask ? 'esc cancel' : `type "${phrase}" then enter · esc cancel`
      }
    >
      {/* The warning is the whole reason this screen exists, so it is stated in
          the warning tone and in plain words rather than implied. */}
      <Box marginBottom={1}>
        <Text bold {...tint(color ? palette.caution : undefined)}>
          {described.label}: {described.risk}
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text {...tint(color ? palette.ink : undefined)}>
          Always confirmed, even unattended:
        </Text>
        <Text {...tint(color ? palette.inkDim : undefined)}>
          {'  · wiping a disk or filesystem root'}
        </Text>
        <Text {...tint(color ? palette.inkDim : undefined)}>
          {'  · deleting your home directory'}
        </Text>
        <Text {...tint(color ? palette.inkDim : undefined)}>
          {'  · editing Atlas’s own safety rules'}
        </Text>
      </Box>
      {perTask ? (
        <Text {...tint(color ? palette.inkDim : undefined)}>
          This applies to this task only. Your default is unchanged.
        </Text>
      ) : (
        <Box>
          <Text {...tint(color ? palette.inkDim : undefined)}>type </Text>
          <Text bold {...tint(color ? palette.caution : undefined)}>
            {phrase}
          </Text>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            {' '}
            to continue
          </Text>
          <Text {...tint(color ? palette.ink : undefined)}>{typed}</Text>
          <Text {...tint(color ? palette.caution : undefined)}>▌</Text>
        </Box>
      )}
    </Modal>
  );
}
