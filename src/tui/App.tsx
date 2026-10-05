/**
 * The Atlas terminal interface.
 *
 * A rendering and interaction layer over the Phase 4 assistant session. It
 * owns no conversation, memory, or permission logic: it submits text to
 * `session.handleInput` and renders the `TurnResult` it gets back.
 *
 * Layout intent:
 *   - completed turns are printed permanently, so scrollback stays readable
 *     and does not reflow as the live region updates;
 *   - the live region at the bottom holds the state indicator, any in-flight
 *     turn, and the input line.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';

import { runAssistantCommand } from '../conversation/assistant-commands.js';
import type { AssistantRuntime } from '../conversation/assistant-runtime.js';
import { resolveTheme, tint, type Palette } from './theme.js';
import { describeState, type AssistantState } from './states.js';
import { revealText } from './reveal.js';
import { StatusBar } from './components/StatusBar.js';
import { TranscriptTurn, type TurnView } from './components/TranscriptTurn.js';
import { Composer, ConfirmationPrompt } from './components/Composer.js';
import { Wordmark } from './components/Wordmark.js';
import { describeToolCall } from '../conversation/narration.js';
import type { TuiBridge } from './bridge.js';

/** A confirmation gate the assistant is blocked on. */
interface PendingConfirmation {
  readonly phrase: string;
  resolve: (approved: boolean) => void;
}

/** A permanent scrollback entry: the splash, or a finished turn. */
type StaticItem = { readonly kind: 'splash' } | TurnView;

export interface AtlasAppProps {
  readonly runtime: AssistantRuntime;
  /** Shared callbacks for the confirmation gate and tool observer. */
  readonly bridge: TuiBridge;
  /** Overrides for tests. */
  readonly animate?: boolean;
  readonly paletteOverride?: Palette;
  readonly colorOverride?: boolean;
  readonly resumed?: boolean;
}

let turnCounter = 0;

export function AtlasApp({
  runtime,
  bridge,
  animate = true,
  paletteOverride,
  colorOverride,
  resumed,
}: AtlasAppProps): React.JSX.Element {
  const { exit } = useApp();
  const theme = useMemo(() => resolveTheme({}), []);
  const palette = paletteOverride ?? theme.palette;
  const color = colorOverride ?? theme.color;
  const motion = animate;

  const [turns, setTurns] = useState<readonly TurnView[]>([]);
  const [state, setState] = useState<AssistantState>('idle');
  const [input, setInput] = useState('');
  /**
   * Mirror of the composer text, updated synchronously.
   *
   * Input arrives in batches, and a submit can land in the same batch as the
   * characters before it. State is too late by then; this ref is not.
   */
  const inputRef = useRef('');
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [gate, setGate] = useState<PendingConfirmation | null>(null);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [liveNotice, setLiveNotice] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // The turn in flight. Lives in the live region, not in scrollback, until it
  // completes.
  const [pendingTurn, setPendingTurn] = useState<TurnView | null>(null);
  // Notices the runtime raised before this component existed.
  const [startupNotices] = useState<readonly string[]>(() =>
    bridge.drainNotices(),
  );

  // The open gate, held in a ref as well as state: `submit` must read the
  // current gate without being rebuilt around it.
  const gateRef = useRef<PendingConfirmation | null>(null);
  gateRef.current = gate;

  // Publish the handlers the runtime was constructed with. The runtime exists
  // before this component mounts, so it is handed these callbacks now.
  useEffect(() => {
    bridge.onGate = (phrase: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setState('awaiting-confirmation');
        setGate({ phrase, resolve });
      });
    bridge.onToolStart = (call): void => {
      setState('executing');
      setDetail(describeToolCall(call));
    };
    return (): void => {
      // Restore the conservative defaults so a torn-down app can never leave
      // the runtime waiting on a handler that no longer exists.
      bridge.onGate = () => Promise.resolve(false);
      bridge.onToolStart = () => undefined;
    };
  }, [bridge]);

  // Restores the idle indicator when a turn finishes or a gate closes.
  useEffect(() => {
    if (!busy && gate === null && state !== 'idle') setState('idle');
  }, [busy, gate, state]);

  /**
   * Runs one assistant turn.
   *
   * The turn lives in the live region while it is in flight and only moves to
   * scrollback once it is finished. That matters because `<Static>` prints an
   * item exactly once: adding the turn up front would freeze it at its empty
   * first frame and the reveal would never be seen.
   */
  const runTurn = useCallback(
    async (message: string): Promise<void> => {
      const id = `turn-${(turnCounter += 1)}`;
      setBusy(true);
      setState('thinking');
      setDetail(undefined);
      setPendingTurn({
        kind: 'turn',
        id,
        user: message,
        narration: '',
        detail: '',
        pending: true,
      });

      let narration: string;
      let detailText: string;
      try {
        const result = await runtime.session.handleInput(message);
        // An empty reply is a provider failure, not a real answer. Say so
        // rather than pretending Atlas had nothing to add.
        narration =
          result.narration === ''
            ? '(no reply came back from the provider; nothing was learned this turn)'
            : result.narration;
        detailText = result.detail;
      } catch (error) {
        narration = `Something went wrong: ${
          error instanceof Error ? error.message : String(error)
        }`;
        detailText = '';
      }

      setState('streaming');
      // The status line keeps the short command label set by the tool
      // observer; stuffing the whole execution log in there is unreadable.

      // Reveal word by word in the live region so the reply reads as it is
      // produced rather than appearing all at once.
      let built = '';
      if (motion) {
        for await (const chunk of revealText(narration)) {
          built += chunk;
          const snapshot = built;
          setPendingTurn((previous) =>
            previous === null
              ? previous
              : { ...previous, narration: snapshot, pending: false },
          );
        }
      } else {
        built = narration;
        setPendingTurn((previous) =>
          previous === null
            ? previous
            : { ...previous, narration: built, pending: false },
        );
      }

      // Finished: commit the complete turn to scrollback exactly once.
      setTurns((previous) => [
        ...previous,
        {
          kind: 'turn',
          id,
          user: message,
          narration: built,
          detail: detailText,
          pending: false,
        },
      ]);
      setPendingTurn(null);
      setBusy(false);
    },
    [runtime, motion],
  );

  const submit = useCallback(
    (line: string): void => {
      inputRef.current = '';
      setInput('');
      // While a gate is open the line answers the gate, not the assistant.
      const openGate = gateRef.current;
      if (openGate !== null) {
        const approved =
          line.trim().toUpperCase() === openGate.phrase.toUpperCase();
        setGate(null);
        setState('executing');
        openGate.resolve(approved);
        return;
      }

      const command = runAssistantCommand(line, {
        facts: runtime.facts,
        corrections: runtime.corrections,
      });
      if (command.kind === 'exit') {
        exit();
        return;
      }
      if (command.kind === 'output') {
        setLiveNotice(command.text);
        return;
      }
      setLiveNotice('');
      void runTurn(command.message);
    },
    [exit, runtime, runTurn],
  );

  useInput((value, key) => {
    if (key.escape) {
      exit();
      return;
    }
    if (key.ctrl && value === 'c') {
      exit();
      return;
    }
    if (key.ctrl && value === 'o') {
      setDetailExpanded((previous) => !previous);
      return;
    }
    if (key.ctrl && value === 'd') {
      exit();
      return;
    }
    if (key.return) {
      // Read the ref, not render state: keystrokes and Enter can arrive in one
      // batch before React re-renders, and a stale read would answer a
      // confirmation gate with text the user never finished typing.
      submit(inputRef.current);
      return;
    }
    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      setInput(inputRef.current);
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      // History navigation is intentionally not wired yet.
      return;
    }
    if (value !== '') {
      inputRef.current += value;
      setInput(inputRef.current);
    }
  });

  // The splash is a permanent part of scrollback; turns join it as they finish.
  const staticItems = useMemo<StaticItem[]>(
    () => [{ kind: 'splash' }, ...turns],
    [turns],
  );

  const descriptor = describeState(state);

  return (
    <Box flexDirection="column">
      {/* Printed once and left in scrollback. The splash belongs here rather
          than in the live region, which would redraw it on every keystroke. */}
      <Static items={staticItems}>
        {(item) => {
          if (item.kind === 'splash') {
            return (
              <Box key="splash" flexDirection="column">
                <Wordmark palette={palette} color={color} />
                {startupNotices.map((notice) => (
                  <Box key={notice} marginBottom={1}>
                    <Text>{notice}</Text>
                  </Box>
                ))}
                <Box marginBottom={1}>
                  <Text {...tint(color ? palette.inkDim : undefined)}>
                    {resumed === true
                      ? 'Resuming your last conversation.'
                      : 'Started a new conversation.'}
                  </Text>
                </Box>
              </Box>
            );
          }
          if (item.kind !== 'turn') return null;
          return (
            <TranscriptTurn
              turn={item}
              palette={palette}
              color={color}
              detailExpanded={detailExpanded}
              onToggleDetail={() => {
                setDetailExpanded((previous) => !previous);
              }}
            />
          );
        }}
      </Static>

      {liveNotice !== '' ? (
        <Box flexDirection="column" marginBottom={1}>
          {liveNotice.split('\n').map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </Box>
      ) : null}

      {/* The in-flight turn sits above the status bar in the live region. */}
      {pendingTurn === null ? null : (
        <TranscriptTurn
          turn={pendingTurn}
          palette={palette}
          color={color}
          detailExpanded={detailExpanded}
          onToggleDetail={() => {
            setDetailExpanded((previous) => !previous);
          }}
          hideUser
        />
      )}

      <Box flexDirection="column">
        <StatusBar
          state={state}
          palette={palette}
          color={color}
          animate={motion}
          {...(detail === undefined ? {} : { detail })}
        />
        {descriptor.awaitsUser && gate !== null ? (
          <ConfirmationPrompt
            palette={palette}
            color={color}
            message="This command needs your approval before it runs."
            phrase={gate.phrase}
          />
        ) : null}
        <Box marginTop={1}>
          <Composer
            palette={palette}
            color={color}
            state={state}
            value={input}
            enabled={!busy}
          />
        </Box>
      </Box>
    </Box>
  );
}
