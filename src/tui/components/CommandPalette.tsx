/**
 * Live-filtered slash-command dropdown.
 *
 * Typed `/` is treated as a discovery mechanism rather than something to
 * memorise: candidates appear as you type, each with its description, and are
 * taken with arrows, Tab, or Enter.
 *
 * This is a presentation layer over the existing command registry, not a second
 * command system, so a command cannot exist in the palette but not in the
 * parser.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { tint, type Palette } from '../theme.js';
import {
  filterAssistantCommands,
  type AssistantCommandSpec,
} from '../../conversation/assistant-commands.js';

export interface CommandPaletteProps {
  /** Current composer text, including the leading slash. */
  readonly query: string;
  readonly palette: Palette;
  readonly color: boolean;
  /** Called with the full command line to submit. */
  readonly onSelect: (command: AssistantCommandSpec) => void;
  /** Called with no argument to close without choosing. */
  readonly onDismiss: () => void;
}

export function CommandPalette({
  query,
  palette,
  color,
  onSelect,
  onDismiss,
}: CommandPaletteProps): React.JSX.Element | null {
  const matches = filterAssistantCommands(query);
  const [index, setIndex] = useState(0);

  // Keep the selection inside the (shrinking) result set while typing.
  const active = Math.min(index, Math.max(0, matches.length - 1));

  useInput((value, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }
    if (key.upArrow || (key.ctrl && value === 'p')) {
      setIndex((previous) =>
        matches.length === 0
          ? 0
          : (previous - 1 + matches.length) % matches.length,
      );
      return;
    }
    if (key.downArrow || (key.ctrl && value === 'n')) {
      setIndex((previous) =>
        matches.length === 0 ? 0 : (previous + 1) % matches.length,
      );
      return;
    }
    if (key.tab || key.return) {
      const chosen = matches[active];
      if (chosen !== undefined) onSelect(chosen);
      return;
    }
  });

  if (matches.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        {...(color ? { borderColor: palette.inkFaint } : {})}
        paddingX={1}
      >
        <Text {...tint(color ? palette.inkDim : undefined)}>
          no command matches “{query.replace(/^\//, '')}”
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(color ? { borderColor: palette.particle } : {})}
      paddingX={1}
    >
      {matches.map((command, position) => {
        const selected = position === active;
        const hint =
          command.takesArgument && command.argumentHint !== undefined
            ? ` <${command.argumentHint}>`
            : '';
        return (
          <Text
            key={command.name}
            bold={selected}
            {...tint(
              color
                ? selected
                  ? palette.particle
                  : palette.inkDim
                : undefined,
            )}
          >
            {selected ? '❯ ' : '  '}/{command.name}
            {hint}
            <Text {...tint(color ? palette.inkFaint : undefined)}>
              {'  '}
              {command.summary}
            </Text>
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text {...tint(color ? palette.inkFaint : undefined)}>
          ↑↓ move · tab or enter run · esc dismiss
        </Text>
      </Box>
    </Box>
  );
}
