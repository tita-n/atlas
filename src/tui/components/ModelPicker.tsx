/**
 * Provider-grouped model picker with type-to-search.
 *
 * Three sections, in the order a user needs them: what is connected now, the
 * full catalogue from the provider list, and a manual entry row for a model
 * the dataset has not caught up with. The catalogue is always present -
 * established harnesses (Claude Code's `/model`, Gemini CLI's `/model,
 * OpenCode's `/models`) all open on a list rather than a single row - and it
 * narrows as you type instead of requiring a page of arrows to reach a
 * vendor.
 *
 * The list is windowed: only the rows around the selection render, so 235
 * providers scroll without flooding the terminal. Rows and headers are one
 * entry list so the window can span section boundaries; the highlight is an
 * index into the rows only, never into a header.
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

/** Rows of the list rendered at once; the rest scroll out of view. */
const VISIBLE_ROWS = 14;

/**
 * First entry of the visible window for a highlighted position.
 *
 * Keeps the selection centred, clamped to both ends so the window never runs
 * off either side of the list. Pure: the maths is the part worth testing,
 * and testing it through a TUI would be slow and fragile.
 */
export function windowStart(
  anchor: number,
  total: number,
  visible: number,
): number {
  if (total <= visible) return 0;
  return Math.min(
    Math.max(anchor - Math.floor(visible / 2), 0),
    total - visible,
  );
}

/** A section heading, rendered but never selectable. */
interface HeaderEntry {
  readonly kind: 'header';
  readonly label: string;
}

/** One selectable row. */
interface RowEntry {
  readonly kind: 'row';
  readonly provider: string;
  readonly choice: ModelChoice;
}

type Entry = HeaderEntry | RowEntry;

export interface ModelPickerProps {
  readonly palette: Palette;
  readonly color: boolean;
  /** Connected / active providers, always shown first. */
  readonly groups: readonly ProviderGroup[];
  /** The full dataset (or search hits), filtered by `query` upstream. */
  readonly catalogue: readonly ProviderGroup[];
  /** Manual entry: always available, and where a typed query lands. */
  readonly manual: { readonly provider: string; readonly choice: ModelChoice };
  readonly activeModel: string;
  /** Live search text typed into the picker. */
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  /** Provenance note, e.g. how the list was sourced or that it is degraded. */
  readonly notice?: string | undefined;
  readonly onSelect: (provider: string, model: string) => void;
  readonly onCancel: () => void;
}

export function ModelPicker({
  palette,
  color,
  groups,
  catalogue,
  manual,
  activeModel,
  query,
  onQueryChange,
  notice,
  onSelect,
  onCancel,
}: ModelPickerProps): React.JSX.Element {
  const entries: Entry[] = [];
  for (const group of groups) {
    entries.push({ kind: 'header', label: group.provider });
    for (const choice of group.models) {
      entries.push({ kind: 'row', provider: group.provider, choice });
    }
  }
  if (catalogue.length > 0) {
    entries.push({
      kind: 'header',
      label: query.trim() === '' ? 'all providers' : 'matches',
    });
    for (const group of catalogue) {
      entries.push({ kind: 'header', label: group.provider });
      for (const choice of group.models) {
        entries.push({ kind: 'row', provider: group.provider, choice });
      }
    }
  }
  entries.push({ kind: 'header', label: manual.provider });
  entries.push({
    kind: 'row',
    provider: manual.provider,
    choice: manual.choice,
  });

  const rows = entries.flatMap((entry, position) =>
    entry.kind === 'row'
      ? [{ position, provider: entry.provider, choice: entry.choice }]
      : [],
  );
  const activeRow = Math.max(
    0,
    rows.findIndex((row) => row.choice.model === activeModel),
  );
  const [index, setIndex] = useState(activeRow);
  // The index is clamped rather than trusted: a query narrows the list under
  // a selection made before it, and a stale index must not point past the end.
  const selected = rows.length === 0 ? 0 : Math.min(index, rows.length - 1);
  const selectedRow = rows[selected];

  const handleQuery = (next: string): void => {
    onQueryChange(next);
    // With text typed, Enter should commit that text - the manual row, always
    // last - rather than whatever row the highlight happened to rest on.
    setIndex(next.trim() === '' ? activeRow : Number.MAX_SAFE_INTEGER);
  };

  useInput((value, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || (key.ctrl && value === 'p')) {
      setIndex((previous) => {
        if (rows.length === 0) return 0;
        const current = Math.min(previous, rows.length - 1);
        return (current - 1 + rows.length) % rows.length;
      });
      return;
    }
    if (key.downArrow || (key.ctrl && value === 'n')) {
      setIndex((previous) => {
        if (rows.length === 0) return 0;
        const current = Math.min(previous, rows.length - 1);
        return (current + 1) % rows.length;
      });
      return;
    }
    if (key.return) {
      if (selectedRow !== undefined) {
        onSelect(selectedRow.provider, selectedRow.choice.model);
      }
      return;
    }
    if (key.backspace || key.delete) {
      handleQuery(query.slice(0, -1));
      return;
    }
    if (value !== '') handleQuery(query + value);
  });

  // Window the entry list so the highlighted row stays on screen: the
  // catalogue is thousands of rows, and rendering them all would push the
  // dialog past the terminal.
  const visible = Math.min(VISIBLE_ROWS, entries.length);
  const start = windowStart(
    selectedRow?.position ?? 0,
    entries.length,
    visible,
  );
  const shown = entries.slice(start, start + visible);

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
        {query.trim() === '' ? null : (
          <Text {...tint(color ? palette.inkDim : undefined)}>
            {'  search: '}
            {query}
          </Text>
        )}
      </Box>
      {shown.map((entry, offset) => {
        const position = start + offset;
        if (entry.kind === 'header') {
          return (
            <Box
              key={`h-${position}-${entry.label}`}
              marginTop={offset === 0 ? 0 : 1}
            >
              <Text bold {...tint(color ? palette.inkDim : undefined)}>
                {entry.label}
              </Text>
            </Box>
          );
        }
        const selectedHere = position === selectedRow?.position;
        const active = entry.choice.model === activeModel;
        return (
          <Text
            key={`r-${position}-${entry.provider}-${entry.choice.model}`}
            bold={selectedHere}
            {...tint(
              color
                ? selectedHere
                  ? palette.particle
                  : palette.ink
                : undefined,
            )}
          >
            {selectedHere ? '❯ ' : '  '}
            {entry.choice.model}
            {active ? '  (current)' : ''}
            {entry.choice.contextWindow === undefined ? null : (
              <Text {...tint(color ? palette.inkFaint : undefined)}>
                {'  '}
                {formatTokens(entry.choice.contextWindow)} ctx
              </Text>
            )}
            {entry.choice.note === undefined ? null : (
              <Text {...tint(color ? palette.inkFaint : undefined)}>
                {'  '}
                {entry.choice.note}
              </Text>
            )}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text {...tint(color ? palette.inkFaint : undefined)}>
          ↑↓ move · type to search · enter select · esc cancel
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
