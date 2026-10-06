/**
 * Provider setup wizard with masked key entry.
 *
 * The key is entered through a masked field and is never echoed into the
 * transcript, the status region, or any log. Terminal text is visible on
 * screen as it is typed, so accepting a secret through the ordinary composer
 * would leave it in scrollback and in any captured terminal.
 *
 * The key is validated before anything is written, so a bad key cannot leave a
 * config file that fails on the next launch.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';

import { tint, type Palette } from '../theme.js';

export type WizardStep =
  'search' | 'provider' | 'endpoint' | 'key' | 'validating' | 'done' | 'failed';

export interface ProviderOption {
  readonly id: string;
  readonly label: string;
  readonly defaultModel: string;
}

export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultModel: 'gpt-4.1-mini',
  },
  {
    id: 'anthropic-compatible',
    label: 'Anthropic-compatible',
    defaultModel: 'claude-sonnet-4-5',
  },
];

/** Sentinel entry that opens manual endpoint entry. */
export const CUSTOM_ENDPOINT = '__custom__';

/** One searchable provider row: a real vendor, or the custom entry. */
export interface ProviderRow {
  readonly id: string;
  readonly label: string;
  readonly note: string;
}

/**
 * Builds the `/init` list: every vendor in the dataset, plus a custom
 * endpoint row for anything the registry has not caught up with.
 */
export function providerRows(input: {
  readonly providers: readonly {
    id: string;
    name: string;
    models: readonly unknown[];
  }[];
  readonly configured?: readonly string[];
}): ProviderRow[] {
  const configured = new Set(input.configured ?? []);
  const rows: ProviderRow[] = input.providers.map((provider) => ({
    id: provider.id,
    label: provider.name,
    note: configured.has(provider.id)
      ? 'key already configured'
      : `${provider.models.length} models`,
  }));
  // Always last: it is a fallback, not a vendor.
  rows.push({
    id: CUSTOM_ENDPOINT,
    label: 'Custom endpoint…',
    note: 'for a provider or model not in the registry',
  });
  return rows;
}

export interface InitWizardProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly step: WizardStep;
  readonly providerIndex: number;
  /**
   * Label of the highlighted row.
   *
   * Shown as the subject of the setup ("API key for Anthropic"). Previously
   * this was derived by indexing the two built-in wire formats with the row
   * position, which named the wrong vendor entirely.
   */
  readonly selectedLabel?: string | undefined;
  readonly model: string;
  /** Masks the key: never the real value. */
  readonly maskedKey: string;
  readonly message?: string | undefined;
  readonly onProvider: (index: number) => void;
  readonly onKeyChange: (masked: string) => void;
  readonly onSubmitKey: () => void;
  readonly onCancel: () => void;
  /** Rows to pick from, already filtered by the search query. */
  readonly rows?: readonly ProviderRow[];
  /** Highlighted row index. */
  readonly index?: number;
  /** Live search text typed into the wizard. */
  readonly query?: string;
  readonly onQueryChange?: (value: string) => void;
  /** The custom endpoint the user typed, for the endpoint step. */
  readonly endpoint?: string;
  readonly onEndpointChange?: (value: string) => void;
}

/** The visible stand-in for a partially entered key. */
/** Rows shown before the list scrolls; enough to scan without flooding. */
const VISIBLE_ROWS = 10;

export function maskKey(value: string): string {
  return value === '' ? '' : '•'.repeat(Math.min(value.length, 64));
}

export function InitWizard({
  palette,
  color,
  step,
  providerIndex,
  selectedLabel,
  model,
  maskedKey,
  message,
  onProvider,
  onKeyChange,
  onSubmitKey,
  onCancel,
  rows,
  index = 0,
  query = '',
  onQueryChange,
  endpoint = '',
  onEndpointChange,
}: InitWizardProps): React.JSX.Element {
  // Scroll the window so the highlighted row is always on screen. Navigating
  // over every row while rendering only the first few left the highlight
  // invisible past the cutoff.
  const rowCount = rows?.length ?? 0;
  const visible = Math.min(VISIBLE_ROWS, rowCount);
  const start =
    rowCount <= visible
      ? 0
      : Math.min(
          Math.max(index - Math.floor(visible / 2), 0),
          rowCount - visible,
        );
  const shown = (rows ?? []).slice(start, start + visible);

  const providerName =
    selectedLabel ?? PROVIDER_OPTIONS[providerIndex]?.label ?? 'this provider';

  useInput(
    (value, key) => {
      if (key.escape) {
        // Escape always leaves without saving, whatever stage we are at.
        onCancel();
        return;
      }

      // Arrows move and Enter chooses on every list step, handled before
      // typing so a search box and the picker never compete for the same keys.
      if (step === 'search' || step === 'provider') {
        // Wrapping is over the rows actually on screen, not over the two
        // built-in wire formats. This used to derive the next index from a
        // prop pinned to 0, so every press returned the same row and the
        // highlight stuck on the second one.
        const count = rows?.length ?? 0;
        if (key.upArrow || key.downArrow) {
          if (count > 0) {
            onProvider(
              key.upArrow ? (index - 1 + count) % count : (index + 1) % count,
            );
          }
          return;
        }
        if (key.return) {
          onSubmitKey();
          return;
        }
        if (key.backspace || key.delete) {
          onQueryChange?.(query.slice(0, -1));
          return;
        }
        if (value !== '') onQueryChange?.(query + value);
        return;
      }

      if (step === 'endpoint') {
        if (key.backspace || key.delete) {
          onEndpointChange?.(endpoint.slice(0, -1));
          return;
        }
        if (value !== '') onEndpointChange?.(endpoint + value);
        return;
      }

      if (step === 'key') {
        if (key.return) {
          onSubmitKey();
          return;
        }
        if (key.backspace || key.delete) {
          onKeyChange(maskedKey.slice(0, -1));
          return;
        }
        if (value !== '') onKeyChange(maskedKey + value);
      }
    },
    {
      isActive:
        step === 'search' ||
        step === 'provider' ||
        step === 'endpoint' ||
        step === 'key',
    },
  );

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
          set up a provider
        </Text>
      </Box>

      {step === 'search' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            search providers
          </Text>
          <Box>
            <Text {...tint(color ? palette.ink : undefined)}>
              {query}
              <Text {...tint(color ? palette.particle : undefined)}>▌</Text>
            </Text>
          </Box>
        </Box>
      ) : null}

      {step === 'endpoint' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            base URL for this provider
          </Text>
          <Box>
            <Text {...tint(color ? palette.ink : undefined)}>
              {endpoint}
              <Text {...tint(color ? palette.particle : undefined)}>▌</Text>
            </Text>
          </Box>
        </Box>
      ) : null}

      {step === 'search' || step === 'provider' ? (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((row, position) => {
            const absolute = start + position;
            const isSelected = absolute === index;
            return (
              <Text
                key={row.id}
                bold={isSelected}
                {...tint(
                  color
                    ? isSelected
                      ? palette.particle
                      : palette.ink
                    : undefined,
                )}
              >
                {isSelected ? '❯ ' : '  '}
                {row.label}
                <Text {...tint(color ? palette.inkFaint : undefined)}>
                  {'  '}
                  {row.note}
                </Text>
              </Text>
            );
          })}
          {rowCount === 0 ? (
            <Text {...tint(color ? palette.inkDim : undefined)}>
              no provider matches "{query}"
            </Text>
          ) : null}
        </Box>
      ) : null}

      {step === 'key' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            API key for {providerName}
          </Text>
          <Box marginTop={1}>
            <Text {...tint(color ? palette.ink : undefined)}>
              {maskedKey}
              <Text {...tint(color ? palette.particle : undefined)}>▌</Text>
            </Text>
          </Box>
          {/* Stated plainly, because "nothing appears" looks broken otherwise. */}
          <Box marginTop={1}>
            <Text {...tint(color ? palette.inkFaint : undefined)}>
              hidden while typing; enter to validate, esc to cancel
            </Text>
          </Box>
        </Box>
      ) : null}

      {step === 'search' || step === 'provider' || step === 'endpoint' ? (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.inkFaint : undefined)}>
            {step === 'search' ? 'type to search · ' : ''}
            {rowCount > visible
              ? `${start + 1}-${start + visible} of ${rowCount} · `
              : ''}
            ↑↓ move · enter choose · esc cancel
          </Text>
        </Box>
      ) : null}

      {step === 'validating' ? (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            checking the key against {providerName}…
          </Text>
        </Box>
      ) : null}

      {step === 'done' ? (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.success : undefined)}>
            saved: {providerName} · {model}
          </Text>
        </Box>
      ) : null}

      {step === 'failed' ? (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.danger : undefined)}>
            {message ?? 'that key was not accepted'}
          </Text>
          <Box marginTop={1}>
            <Text {...tint(color ? palette.inkFaint : undefined)}>
              esc to go back
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
