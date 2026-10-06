/**
 * A tool call rendered as its own block in the transcript.
 *
 * This is the interaction behind the narration/execution separation rule: a
 * tool call is not styled differently prose, it is a different kind of object
 * with its own collapsed and expanded states. Collapsed, it is one line naming
 * the tool, its key argument, and what happened; expanded, it shows the real
 * output.
 *
 * Each block expands on its own. A single global toggle does not work — the
 * terminals that have one report users leaving it off, because most tool
 * output is noise and the few tools that matter get hidden with it.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';

import { tint, type Palette } from '../theme.js';
import {
  collapseOutput,
  collapseLinesFor,
  summarizeTool,
  type ToolStatus,
} from '../tool-blocks.js';

export interface ToolBlockView {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly status: ToolStatus;
  readonly detail: string;
  readonly exitCode?: number | null | undefined;
  readonly durationMs?: number | undefined;
}

export interface ToolBlockProps {
  readonly call: ToolBlockView;
  readonly palette: Palette;
  readonly color: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** The block currently accepting a keypress; only that one is interactive. */
  readonly focused: boolean;
}

export function ToolBlock({
  call,
  palette,
  color,
  expanded,
  onToggle,
  focused,
}: ToolBlockProps): React.JSX.Element {
  // Only the focused block listens, so one keypress cannot toggle every block.
  useInput(
    (value, key) => {
      if (value === 'o' || key.return) onToggle();
    },
    { isActive: focused },
  );

  const summary = summarizeTool({
    toolName: call.name,
    status: call.status,
    argument: call.command,
    detail: call.detail,
    durationMs: call.durationMs,
    exitCode: call.exitCode,
  });

  const tone =
    call.status === 'failed'
      ? color
        ? palette.danger
        : undefined
      : call.status === 'running'
        ? color
          ? palette.particle
          : undefined
        : color
          ? palette.inkDim
          : undefined;

  const body = expanded
    ? call.detail
    : collapseOutput(call.detail, collapseLinesFor(call.name)).preview.join(
        '\n',
      );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(color ? { borderColor: tone ?? palette.inkFaint } : {})}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold {...tint(tone)}>
          {summary.label}
        </Text>
        {/* The argument is on the collapsed line so the block means something
            before it is expanded. */}
        <Text {...tint(color ? palette.ink : undefined)}>
          {'  '}
          {truncate(call.command, 48)}
        </Text>
        <Text {...tint(color ? palette.inkFaint : undefined)}>
          {'  '}
          {summary.annotation}
        </Text>
      </Box>
      {body === '' ? null : (
        <Box flexDirection="column" marginTop={1}>
          {body.split('\n').map((line, index) => (
            <Text
              key={`${index}-${line}`}
              {...tint(color ? palette.inkDim : undefined)}
            >
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={expanded ? 1 : 0}>
        <Text {...tint(color ? palette.inkFaint : undefined)}>
          {expanded
            ? 'ctrl+o or enter to collapse'
            : 'ctrl+o or enter to expand'}
        </Text>
      </Box>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
