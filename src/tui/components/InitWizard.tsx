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

export type WizardStep = 'provider' | 'key' | 'validating' | 'done' | 'failed';

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

export interface InitWizardProps {
  readonly palette: Palette;
  readonly color: boolean;
  readonly step: WizardStep;
  readonly providerIndex: number;
  readonly model: string;
  /** Masks the key: never the real value. */
  readonly maskedKey: string;
  readonly message?: string | undefined;
  readonly onProvider: (index: number) => void;
  readonly onKeyChange: (masked: string) => void;
  readonly onSubmitKey: () => void;
  readonly onCancel: () => void;
}

/** The visible stand-in for a partially entered key. */
export function maskKey(value: string): string {
  return value === '' ? '' : '•'.repeat(Math.min(value.length, 64));
}

export function InitWizard({
  palette,
  color,
  step,
  providerIndex,
  model,
  maskedKey,
  message,
  onProvider,
  onKeyChange,
  onSubmitKey,
  onCancel,
}: InitWizardProps): React.JSX.Element {
  const provider = PROVIDER_OPTIONS[providerIndex] ?? PROVIDER_OPTIONS[0];

  useInput(
    (value, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (step === 'provider') {
        if (key.upArrow) {
          onProvider(
            (providerIndex - 1 + PROVIDER_OPTIONS.length) %
              PROVIDER_OPTIONS.length,
          );
          return;
        }
        if (key.downArrow) {
          onProvider((providerIndex + 1) % PROVIDER_OPTIONS.length);
          return;
        }
        if (key.return) {
          onSubmitKey();
        }
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
    { isActive: step === 'provider' || step === 'key' },
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

      {step === 'provider' ? (
        <Box flexDirection="column" marginTop={1}>
          {PROVIDER_OPTIONS.map((option, index) => (
            <Text
              key={option.id}
              bold={index === providerIndex}
              {...tint(
                color
                  ? index === providerIndex
                    ? palette.particle
                    : palette.ink
                  : undefined,
              )}
            >
              {index === providerIndex ? '❯ ' : '  '}
              {option.label}
              <Text {...tint(color ? palette.inkFaint : undefined)}>
                {'  '}
                {option.defaultModel}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}

      {step === 'key' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            API key for {provider?.label ?? ''}
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

      {step === 'validating' ? (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            checking the key against {provider?.label ?? ''}…
          </Text>
        </Box>
      ) : null}

      {step === 'done' ? (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.success : undefined)}>
            saved: {provider?.label ?? ''} · {model}
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
