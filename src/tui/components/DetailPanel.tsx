/**
 * The execution-detail panel.
 *
 * Phase 4 already separates a turn's `narration` from its `detail`; this
 * component is what makes that separation *visible*. Detail gets its own
 * bordered, dimmed region with a persistent header, so raw commands and
 * output can never be mistaken for something Atlas said.
 *
 * The distinction survives color being off: the border, the header word, and
 * the indentation carry it, not the hue.
 */
import React from 'react';
import { Box, Text } from 'ink';

import { tint, type Palette } from '../theme.js';
import { tokenize, supportsLanguage, type TokenKind } from '../highlight.js';

export interface DetailPanelProps {
  readonly detail: string;
  readonly palette: Palette;
  readonly color: boolean;
  readonly expanded: boolean;
  /** Toggles collapse; omitted renders a non-collapsible panel. */
  readonly onToggle?: () => void;
}

const HEADER_HINT = 'ctrl+o toggles';

export function DetailPanel({
  detail,
  palette,
  color,
  expanded,
  onToggle,
}: DetailPanelProps): React.JSX.Element {
  const border = color ? palette.inkFaint : undefined;
  const text = expanded ? detail : summarize(detail);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(border === undefined ? {} : { borderColor: border })}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text {...tint(color ? palette.inkDim : undefined)}>
          execution detail
        </Text>
        <Text {...tint(color ? palette.inkFaint : undefined)}>
          {expanded ? '' : ` (${lineCount(detail)} lines hidden)`}
        </Text>
        {onToggle === undefined ? null : (
          <Text {...tint(color ? palette.inkFaint : undefined)}>
            {`  [${expanded ? 'collapse' : 'expand'} · ${HEADER_HINT}]`}
          </Text>
        )}
      </Box>
      {expanded ? (
        <Box flexDirection="column" marginTop={1}>
          {renderDetail(text, palette, color)}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text {...tint(color ? palette.inkDim : undefined)}>
            {firstCommand(text)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function lineCount(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

function firstCommand(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/** Keeps the collapsed view to one identifying line. */
function summarize(detail: string): string {
  const first = firstCommand(detail);
  return first === '' ? detail : first;
}

/**
 * Renders detail text with shell syntax highlighting where it applies.
 *
 * Indented by one column so the panel body reads as quoted material, distinct
 * from the narration above it even with all styling removed.
 */
function renderDetail(
  detail: string,
  palette: Palette,
  color: boolean,
): React.JSX.Element[] {
  return detail.split('\n').map((line, index) => (
    <Text key={`${index}-${line}`}>
      {'  '}
      {tokenizeLineWithColors(line, palette, color)}
    </Text>
  ));
}

function tokenizeLineWithColors(
  line: string,
  palette: Palette,
  color: boolean,
): React.JSX.Element {
  // No color means the raw line is returned unchanged, so nothing depends on
  // highlighting having run.
  if (!color) return <Text>{line}</Text>;
  return (
    <>
      {tokenize(line).map((token, index) => (
        <Text key={index} {...tint(colorFor(token.kind, palette))}>
          {token.value}
        </Text>
      ))}
    </>
  );
}

function colorFor(kind: TokenKind, palette: Palette): string | undefined {
  switch (kind) {
    case 'comment':
      return palette.inkFaint;
    case 'string':
      return palette.success;
    case 'number':
      return palette.caution;
    case 'keyword':
      return palette.particle;
    case 'operator':
      return palette.info;
    default:
      return palette.ink;
  }
}

/** Whether a language is one the highlighter understands. */
export { supportsLanguage };
