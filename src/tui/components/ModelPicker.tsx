/**
 * Provider-grouped model picker.
 *
 * Models are grouped by the provider that serves them and shown with whatever
 * the local config actually knows, including the active context window where
 * one is configured. A flat list of names hides which provider serves what and
 * gives no basis for a choice.
 *
 * Nothing here is invented: a model with no known context window is shown
 * without one rather than with a guess.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { tint, type Palette } from '../theme.js';
import { formatTokens } from '../tool-blocks.js';

export interface ModelChoice {
  readonly model: string;
  readonly contextWindow?: number | undefined;
  /** Free-form note, e.g. a configured local endpoint. */
  readonly note?: string | undefined;
}

export interface ProviderGroup {
  readonly provider: string;
  readonly models: readonly ModelChoice[];
}

export interface ModelPickerProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly groups: readonly ProviderGroup[];
  readonly activeModel: string;
  /** Provenance note, e.g. how the list was sourced or that it is degraded. */
  readonly notice?: string | undefined;
  readonly onSelect: (provider: string, model: string) => void;
  readonly onCancel: () => void;
}

export function ModelPicker({
  palette,
  color,
  groups,
  activeModel,
  notice,
  onSelect,
  onCancel,
}: ModelPickerProps): React.JSX.Element {
  const flat = groups.flatMap((group) =>
    group.models.map((choice) => ({ provider: group.provider, choice })),
  );
  const initial = Math.max(
    0,
    flat.findIndex((entry) => entry.choice.model === activeModel),
  );
  const [index, setIndex] = useState(initial);

  useInput((value, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || (key.ctrl && value === 'p')) {
      setIndex((previous) =>
        flat.length === 0 ? 0 : (previous - 1 + flat.length) % flat.length,
      );
      return;
    }
    if (key.downArrow || (key.ctrl && value === 'n')) {
      setIndex((previous) =>
        flat.length === 0 ? 0 : (previous + 1) % flat.length,
      );
      return;
    }
    if (key.return) {
      const entry = flat[index];
      if (entry !== undefined) onSelect(entry.provider, entry.choice.model);
    }
  });

  let lastProvider: string | undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(color ? { borderColor: palette.particle } : {})}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold {...tint(color ? palette.particle : undefined)}>
          select a model
        </Text>
      </Box>
      {groups.map((group) => (
        <Box key={group.provider} flexDirection="column" marginTop={1}>
          <Text bold {...tint(color ? palette.inkDim : undefined)}>
            {group.provider}
          </Text>
          {group.models.map((choice) => {
            const position = flat.findIndex(
              (entry) =>
                entry.provider === group.provider &&
                entry.choice.model === choice.model,
            );
            const selected = position === index;
            const active = choice.model === activeModel;
            if (group.provider !== lastProvider) lastProvider = group.provider;
            return (
              <Text
                key={`${group.provider}-${choice.model}`}
                bold={selected}
                {...tint(
                  color
                    ? selected
                      ? palette.particle
                      : palette.ink
                    : undefined,
                )}
              >
                {selected ? '❯ ' : '  '}
                {choice.model}
                {active ? '  (current)' : ''}
                {choice.contextWindow === undefined ? null : (
                  <Text {...tint(color ? palette.inkFaint : undefined)}>
                    {'  '}
                    {formatTokens(choice.contextWindow)} ctx
                  </Text>
                )}
                {choice.note === undefined ? null : (
                  <Text {...tint(color ? palette.inkFaint : undefined)}>
                    {'  '}
                    {choice.note}
                  </Text>
                )}
              </Text>
            );
          })}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text {...tint(color ? palette.inkFaint : undefined)}>
          ↑↓ move · enter select · esc cancel
        </Text>
      </Box>
      {notice === undefined ? null : (
        <Box>
          <Text {...tint(color ? palette.inkFaint : undefined)}>{notice}</Text>
        </Box>
      )}
    </Box>
  );
}
