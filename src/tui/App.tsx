/**
 * The Atlas terminal interface.
 *
 * A rendering and interaction layer over the Phase 4 assistant session. It owns
 * no conversation, memory, or permission logic: it submits text to the session
 * and renders what comes back.
 *
 * The interaction model, rather than the styling, is the point of this file:
 *
 *   - a decision that needs an answer gets a modal of its own, so it cannot be
 *     scrolled past and mistaken for something Atlas said;
 *   - `/` is a discovery mechanism, not syntax to memorise;
 *   - provider, model, turn count, and tokens are always visible;
 *   - each tool call is its own block with a live status, collapsed by default;
 *   - prompts typed while a turn is running are queued rather than discarded.
 *
 * Everything decorative stays optional. Colour and motion are layered on top of
 * text labels and borders, so the interface works identically with NO_COLOR, on
 * a dumb terminal, and under a screen reader.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';

import {
  runAssistantCommand,
  filterAssistantCommands,
  type AssistantCommandSpec,
} from '../conversation/assistant-commands.js';
import { describeToolCall } from '../conversation/narration.js';
import type { AssistantRuntime } from '../conversation/assistant-runtime.js';
import type { TurnToolCall } from '../conversation/session.js';
import {
  formatPrice,
  loadRegistry,
  type ModelInfo,
  type ProviderInfo,
  type RegistrySnapshot,
} from '../providers/model-registry.js';
import { resolveTheme, tint, type Palette } from './theme.js';
import { describeState, type AssistantState } from './states.js';
import {
  emptyStats,
  recordToolCall,
  recordTurn,
  type SessionStats,
} from './session-stats.js';
import type { ToolStatus } from './tool-blocks.js';
import { StatusBar } from './components/StatusBar.js';
import { TranscriptTurn, type TurnView } from './components/TranscriptTurn.js';
import { Composer } from './components/Composer.js';
import { Wordmark } from './components/Wordmark.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { ModelPicker, type ProviderGroup } from './components/ModelPicker.js';
import {
  AutonomyModal,
  type AutonomyStep,
} from './components/AutonomyModal.js';
import {
  AUTONOMY_LEVELS,
  loadAutonomy,
  saveAutonomy,
  type AutonomyLevel,
} from '../permissions/autonomy.js';
import {
  InitWizard,
  PROVIDER_OPTIONS,
  maskKey,
  providerRows,
  type WizardStep,
  CUSTOM_ENDPOINT,
} from './components/InitWizard.js';
import { fuzzyFilter } from './fuzzy.js';
import { protocolFor } from '../providers/model-registry.js';
import { StatusFooter } from './components/StatusFooter.js';
import type { ToolBlockView } from './components/ToolBlock.js';
import type { GateDecision, TuiBridge } from './bridge.js';

/** A permanent scrollback entry: the splash, or a finished turn. */
type StaticItem = { readonly kind: 'splash' } | TurnView;

/**
 * Rows shown per vendor in the /model picker. The picker renders every row it
 * is handed, and the largest catalogue in the dataset is 610 models, so an
 * uncapped group would bury the manual entry that keeps /model usable.
 */
const MODELS_PER_PROVIDER = 12;

/**
 * Picks a vendor's models for the picker: at most `MODELS_PER_PROVIDER` of
 * them, with the configured model kept even when it falls outside that window
 * (vendors are ordered by context window, not by what the user is using).
 */
function pickModels(
  provider: ProviderInfo,
  activeModel: string,
): readonly ModelInfo[] {
  const all = provider.models;
  if (all.length <= MODELS_PER_PROVIDER) return all;
  const active = all.find((entry) => entry.id === activeModel);
  if (active === undefined) return all.slice(0, MODELS_PER_PROVIDER);
  const head = all.slice(0, MODELS_PER_PROVIDER).filter((e) => e !== active);
  return [active, ...head].slice(0, MODELS_PER_PROVIDER);
}

/** Which modal, if any, owns the keyboard. */
type ModalKind = 'none' | 'confirm' | 'palette' | 'model' | 'init' | 'autonomy';

interface PendingGate {
  readonly phrase: string;
  readonly command: string;
  readonly reason?: string | undefined;
  resolve: (decision: GateDecision) => void;
}

/** A tool call as it moves through its lifecycle, including before a turn ends. */
interface LiveTool {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  status: ToolStatus;
  detail: string;
  exitCode?: number | null | undefined;
  durationMs?: number | undefined;
  expanded: boolean;
}

/** Projects a registry model into what the picker renders. */
function toModelChoice(entry: {
  id: string;
  context: number;
  pricing?: { input: number; output: number } | undefined;
}): ProviderGroup['models'][number] {
  return {
    model: entry.id,
    ...(entry.context === 0 ? {} : { contextWindow: entry.context }),
    note: formatPrice(entry.pricing) ?? 'no published price',
  };
}

export interface AtlasAppProps {
  readonly runtime: AssistantRuntime;
  readonly bridge: TuiBridge;
  readonly animate?: boolean;
  /** Overrides for tests. */
  readonly paletteOverride?: Palette;
  readonly colorOverride?: boolean;
  readonly resumed?: boolean;
  /** Known context window; omitted rather than guessed. */
  readonly contextWindow?: number | undefined;
  /** Validates a provider key. Kept injectable so tests never hit a network. */
  readonly validateKey?: (
    provider: string,
    key: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Persists a validated configuration. */
  readonly saveConfig?: (input: {
    provider: string;
    apiKey: string;
    model: string;
    /** Set when the user configured a custom endpoint in /init. */
    baseUrl?: string;
  }) => Promise<void>;
}

let turnCounter = 0;
let toolCounter = 0;

export function AtlasApp({
  runtime,
  bridge,
  animate = true,
  paletteOverride,
  colorOverride,
  resumed,
  contextWindow,
  validateKey,
  saveConfig,
}: AtlasAppProps): React.JSX.Element {
  const { exit } = useApp();
  const theme = useMemo(() => resolveTheme({}), []);
  const palette = paletteOverride ?? theme.palette;
  const color = colorOverride ?? theme.color;
  const motion = animate;

  const [turns, setTurns] = useState<readonly TurnView[]>([]);
  const [state, setState] = useState<AssistantState>('idle');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<TurnView | null>(null);
  const [liveNotice, setLiveNotice] = useState('');
  // Off by default: reasoning is available, never in the way.
  const [showReasoning, setShowReasoning] = useState(false);
  const [modal, setModal] = useState<ModalKind>('none');
  const [gate, setGate] = useState<PendingGate | null>(null);
  const [statusDetail, setStatusDetail] = useState<string | undefined>(
    undefined,
  );
  const [stats, setStats] = useState<SessionStats>(emptyStats);
  const [model, setModelState] = useState(runtime.config.model);
  const [liveTools, setLiveTools] = useState<readonly LiveTool[]>([]);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [focusedTool, setFocusedTool] = useState<string | null>(null);
  /** Prompts typed while a turn is running, sent in order afterwards. */
  const [queue, setQueue] = useState<readonly string[]>([]);

  // Wizard state
  const [wizardStep, setWizardStep] = useState<WizardStep>('provider');
  // Index into the filtered /init rows; kept derived so filtering and
  // highlighting cannot drift apart.
  const wizardProvider = 0;
  const [wizardKey, setWizardKey] = useState('');
  const [wizardMessage, setWizardMessage] = useState<string | undefined>(
    undefined,
  );
  const [wizardQuery, setWizardQuery] = useState('');
  const [wizardIndex, setWizardIndex] = useState(0);
  const [wizardEndpoint, setWizardEndpoint] = useState('');
  const [autonomyLevel, setAutonomyLevel] =
    useState<AutonomyLevel>('confirm-everything');
  const [autonomyStep, setAutonomyStep] = useState<AutonomyStep>('pick');
  const [autonomyIndex, setAutonomyIndex] = useState(0);
  const [autonomyTyped, setAutonomyTyped] = useState('');

  // Read once on mount so the picker shows the real level rather than the
  // default. Saved changes update it immediately below.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = await loadAutonomy(
        runtime.assistantConfig.homeDirectory,
      );
      if (cancelled) return;
      setAutonomyLevel(settings.level);
      const at = AUTONOMY_LEVELS.indexOf(settings.level);
      setAutonomyIndex(at < 0 ? 0 : at);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime.assistantConfig.homeDirectory]);
  /** The vendor chosen from the list, before a key is entered. */
  const [wizardSelected, setWizardSelected] = useState<{
    id: string;
    label: string;
    baseUrl?: string | undefined;
    protocol?: 'openai-compatible' | 'anthropic-compatible' | undefined;
  } | null>(null);

  const [registry, setRegistry] = useState<RegistrySnapshot>({
    providers: [],
    fetchedAt: 0,
    source: 'cache',
  });
  const [registryNotice, setRegistryNotice] = useState<string | undefined>(
    undefined,
  );
  const [registryLoading, setRegistryLoading] = useState(true);

  /** Providers the user has already connected, from the key in the environment. */
  const configuredProviders = useMemo(
    () =>
      registry.providers
        .filter((provider) =>
          provider.env.some(
            (name) =>
              (process.env[name] ?? '').trim() !== '' ||
              (runtime.config.baseUrl !== '' &&
                provider.baseUrl === runtime.config.baseUrl),
          ),
        )
        .map((provider) => provider.id),
    [registry.providers, runtime.config.baseUrl],
  );

  /** `/init` rows, filtered live by the search query. */
  const wizardRows = useMemo(() => {
    const all = providerRows({
      providers: registry.providers,
      configured: configuredProviders,
    });
    return fuzzyFilter(all, wizardQuery).map((ranked) => ranked.item);
  }, [registry.providers, configuredProviders, wizardQuery]);

  const inputRef = useRef('');
  const gateRef = useRef<PendingGate | null>(null);
  gateRef.current = gate;
  const [startupNotices] = useState<readonly string[]>(() =>
    bridge.drainNotices(),
  );

  // The provider/model catalogue comes from models.dev, cached on disk. A
  // failure here must never block the interface: it degrades to whatever is
  // cached, and manual entry keeps working.

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadRegistry({
        atlasHome: runtime.assistantConfig.homeDirectory,
      });
      if (cancelled) return;
      setRegistry(result.snapshot);
      setRegistryLoading(false);
      if (result.stale) {
        setRegistryNotice(
          result.snapshot.providers.length === 0
            ? `could not reach models.dev (${
                result.error ?? 'unknown error'
              }); manual entry still works`
            : `models.dev unreachable; showing a cached list`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime.assistantConfig.homeDirectory]);

  // Publish the handlers the runtime was constructed with.
  useEffect(() => {
    bridge.onGate = (request): Promise<GateDecision> =>
      new Promise<GateDecision>((resolve) => {
        bridge.pendingCommand = request.command;
        bridge.pendingReason = request.reason;
        setState('awaiting-confirmation');
        setModal('confirm');
        setGate({
          phrase: request.phrase,
          command:
            request.command === ''
              ? (bridge.pendingCommand ?? '')
              : request.command,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          resolve,
        });
      });
    bridge.onToolStart = (call): void => {
      const id = `tool-${(toolCounter += 1)}`;
      const command = safeDescribe(call);
      // Published before execution so the confirmation modal can name what it
      // is approving, rather than asking about an unnamed action.
      bridge.pendingCommand = command;
      setLiveTools((previous) => [
        ...previous,
        {
          id,
          name: call.name,
          command,
          status: 'running',
          detail: '',
          expanded: false,
        },
      ]);
      setFocusedTool(id);
      setState('executing');
      setStatusDetail(command);
      setStats(recordToolCall);
    };
    return (): void => {
      bridge.onGate = () => Promise.resolve('deny');
      bridge.onToolStart = () => undefined;
    };
  }, [bridge]);

  // Fold a finished turn's tool calls into the transcript.
  const finishTools = useCallback((calls: readonly TurnToolCall[]): void => {
    setLiveTools((previous) =>
      calls.map((call, index) => {
        const existing = previous[index];
        return {
          id: existing?.id ?? `tool-${(toolCounter += 1)}`,
          name: call.name,
          command: call.command,
          status: call.ok ? 'succeeded' : 'failed',
          detail: call.detail,
          exitCode: null,
          durationMs: call.durationMs,
          expanded: existing?.expanded ?? false,
        };
      }),
    );
    setFocusedTool(null);
  }, []);

  const runTurn = useCallback(
    async (message: string): Promise<void> => {
      turnCounter += 1;
      const id = `turn-${turnCounter}`;
      setBusy(true);
      setState('thinking');
      setStatusDetail(undefined);
      setLiveTools([]);
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
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      let calls: readonly TurnToolCall[] = [];
      try {
        const result = await runtime.session.handleInputStreaming(
          message,
          (delta) => {
            // Narration as it is produced, shown in the live turn below. The
            // guard upstream already withheld anything that could be a payload,
            // so this text is safe to display immediately.
            setState('streaming');
            setPendingTurn((previous) =>
              previous === null
                ? previous
                : {
                    ...previous,
                    narration: previous.narration + delta,
                    pending: false,
                  },
            );
          },
        );
        narration =
          result.narration === ''
            ? '(no reply came back from the provider; nothing was learned this turn)'
            : result.narration;
        detailText = result.detail;
        usage = result.usage;
        calls = result.toolCalls ?? [];
      } catch (error) {
        narration = `Something went wrong: ${
          error instanceof Error ? error.message : String(error)
        }`;
        detailText = '';
      }

      // The turn is complete before reveal begins: the live region must not
      // show a half-written turn that the committed one then contradicts.
      setTurns((previous) => [
        ...previous,
        {
          kind: 'turn',
          id,
          user: message,
          narration,
          detail: detailText,
          pending: false,
          toolCalls: calls,
        },
      ]);
      setPendingTurn(null);
      setStats((previous) => recordTurn(previous, usage));
      setBusy(false);
      setState('idle');
    },
    [runtime, finishTools],
  );

  // Send the next queued prompt once the current turn finishes.
  //
  // The queue array is the only source of ordering. An earlier version kept a
  // separate cursor into the same array while also slicing it, which
  // desynchronized the two: prompts were dropped, ran out of order, and could
  // leave the queue permanently stuck.
  useEffect(() => {
    if (busy) return;
    const next = queue[0];
    if (next === undefined) return;
    setQueue((previous) => previous.slice(1));
    void runTurn(next);
  }, [busy, queue, runTurn]);

  const submit = useCallback(
    (line: string): void => {
      inputRef.current = '';
      setInput('');

      const openGate = gateRef.current;
      if (openGate !== null) {
        // The modal owns the keyboard while a gate is open; reaching here means
        // the user typed anyway, which must never count as approval.
        return;
      }

      if (line === '') return;
      if (line.trim() === '/reasoning') {
        setShowReasoning((previous) => !previous);
        setLiveNotice('');
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
      if (command.kind === 'prose') {
        setLiveNotice('');
        if (busy) {
          // Queue rather than drop: a prompt typed mid-turn is a real
          // request, and losing it is indistinguishable from a hang.
          setQueue((previous) => [...previous, command.message]);
          setLiveNotice('queued until the current turn finishes');
          return;
        }
        void runTurn(command.message);
      }
    },
    [exit, runtime, runTurn, busy],
  );

  const closeGate = useCallback((decision: GateDecision): void => {
    const openGate = gateRef.current;
    setGate(null);
    setModal('none');
    if (openGate !== null) openGate.resolve(decision);
  }, []);

  // Live tool output during the current turn, rendered above the composer.
  const toolBlocks: readonly ToolBlockView[] = liveTools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    command: tool.command,
    status: tool.status,
    detail: tool.detail,
    exitCode: tool.exitCode,
    durationMs: tool.durationMs,
  }));

  // The command palette is an overlay on the composer, not a modal over it:
  // typing must keep going so the query can be filtered as the user types.
  // Every other modal genuinely owns the keyboard.
  const composerLocked = modal !== 'none' && modal !== 'palette';

  // The splash is permanent scrollback; turns join it as they finish.
  const staticItems = useMemo<StaticItem[]>(
    () => [{ kind: 'splash' }, ...turns],
    [turns],
  );

  useInput(
    (value, key) => {
      // A modal owns the keyboard; the composer must not also act on it. The
      // palette is exempt because it only completes what is being typed.
      if (composerLocked) return;
      if (key.escape) {
        exit();
        return;
      }
      if (key.ctrl && value === 'c') {
        exit();
        return;
      }
      if (key.ctrl && value === 'd') {
        exit();
        return;
      }
      if (key.ctrl && value === 'o') {
        setExpandedTools((previous) =>
          previous.size === 0
            ? new Set(toolBlocks.map((tool) => tool.id))
            : new Set(),
        );
        return;
      }
      if (key.return && modal === 'palette') {
        // The palette selects the highlighted command itself.
        return;
      }
      if (key.return) {
        // `/model` and `/init` open modals rather than being handled inline.
        const trimmed = inputRef.current.trim();
        if (trimmed === '/model') {
          setModal('model');
          return;
        }
        if (trimmed === '/autonomy') {
          setAutonomyStep('pick');
          setAutonomyTyped('');
          setAutonomyIndex(Math.max(0, AUTONOMY_LEVELS.indexOf(autonomyLevel)));
          setModal('autonomy');
          return;
        }
        if (trimmed === '/init') {
          setWizardStep('search');
          setWizardKey('');
          setWizardQuery('');
          setWizardIndex(0);
          setWizardEndpoint('');
          setModal('init');
          return;
        }
        if (
          trimmed.startsWith('/') &&
          filterAssistantCommands(trimmed).length > 0
        ) {
          setModal('palette');
          return;
        }
        submit(inputRef.current);
        return;
      }
      if (key.backspace || key.delete) {
        inputRef.current = inputRef.current.slice(0, -1);
        setInput(inputRef.current);
        return;
      }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
        return;
      if (value !== '') {
        inputRef.current += value;
        setInput(inputRef.current);
        // Typing `/` on an empty line opens discovery immediately.
        if (inputRef.current === '/') setModal('palette');
      }
    },
    { isActive: !composerLocked },
  );

  const descriptor = describeState(state);
  const paletteOpen = modal === 'palette' && inputRef.current.startsWith('/');

  const chooseCommand = useCallback(
    (command: AssistantCommandSpec): void => {
      setModal('none');
      inputRef.current = `/${command.name}`;
      setInput(inputRef.current);
      if (command.opensModal) {
        if (command.name === 'model') setModal('model');
        if (command.name === 'autonomy') {
          setAutonomyStep('pick');
          setAutonomyTyped('');
          setModal('autonomy');
        }
        if (command.name === 'init') {
          setWizardStep('provider');
          setWizardKey('');
          setModal('init');
        }
        return;
      }
      submit(`/${command.name}`);
    },
    [submit],
  );

  const registryMeta = registryLoading
    ? 'loading models.dev...'
    : `${registry.providers.length} providers from models.dev`;

  /**
   * Models available to switch to.
   *
   * Scoped to providers the user has already connected. Listing every vendor
   * in the dataset here was wrong: `/model` switches between models you can
   * actually reach, and `/init` is where a provider gets added. Established
   * harnesses scope the picker the same way.
   */
  const modelGroups: readonly ProviderGroup[] = useMemo(() => {
    const groups: ProviderGroup[] = [];
    const activeVendor = registry.providers.find(
      (provider) =>
        provider.baseUrl?.replace(/\/+$/, '') ===
        runtime.config.baseUrl.replace(/\/+$/, ''),
    );

    if (activeVendor !== undefined) {
      groups.push({
        provider: activeVendor.name,
        models: pickModels(activeVendor, model).map(toModelChoice),
      });
    } else {
      // Configured against an endpoint the registry does not describe - a
      // proxy, a local server, or a custom endpoint from /init.
      groups.push({
        provider: 'configured endpoint',
        models: [{ model, note: 'active this session' }],
      });
    }

    // Manual entry stays available: the registry is community-maintained and
    // a genuinely new model may not be in it yet.
    groups.push({
      provider: 'not listed?',
      models: [
        {
          model,
          note: 'enter any model id — /init adds a custom endpoint',
        },
      ],
    });
    return groups;
  }, [registry.providers, runtime.config.baseUrl, model]);

  const submitKey = useCallback(async (): Promise<void> => {
    const chosen = wizardRows[wizardIndex];

    if (wizardStep === 'search' || wizardStep === 'provider') {
      if (chosen === undefined) return;
      const vendor = registry.providers.find((p) => p.id === chosen.id);
      setWizardSelected({
        id: chosen.id,
        label: chosen.label,
        baseUrl: vendor?.baseUrl,
        // Undefined protocol means genuinely unknown, so the UI asks rather
        // than guessing a wire format.
        protocol: vendor === undefined ? undefined : protocolFor(vendor),
      });
      // A provider the dataset has no endpoint for needs one typed in before a
      // key can be validated against it.
      setWizardStep(chosen.id === CUSTOM_ENDPOINT ? 'endpoint' : 'key');
      return;
    }
    if (wizardStep === 'endpoint') {
      if (wizardEndpoint.trim() === '') return;
      setWizardStep('key');
      return;
    }
    if (wizardStep !== 'key' || wizardKey === '') return;
    setWizardStep('validating');
    // A custom endpoint is OpenAI-compatible unless the user says otherwise,
    // because that is what nearly every self-hosted gateway speaks.
    const provider = wizardSelected?.protocol ?? runtime.config.provider;
    const model =
      wizardSelected?.id === CUSTOM_ENDPOINT
        ? wizardEndpoint
        : (PROVIDER_OPTIONS[wizardProvider]?.defaultModel ??
          wizardSelected?.id ??
          runtime.config.model);
    if (validateKey === undefined) {
      setWizardStep('done');
      return;
    }
    const result = await validateKey(provider, wizardKey);
    if (result.ok) {
      if (saveConfig !== undefined) {
        await saveConfig({
          provider,
          apiKey: wizardKey,
          model,
          ...(wizardSelected?.id === CUSTOM_ENDPOINT &&
          wizardEndpoint.trim() !== ''
            ? { baseUrl: wizardEndpoint.trim() }
            : {}),
        });
      }
      // Drop the secret as soon as it is no longer needed.
      setWizardKey('');
      setWizardMessage(undefined);
      setWizardStep('done');
      return;
    }
    setWizardMessage(result.message ?? 'that key was not accepted');
    setWizardStep('failed');
  }, [
    wizardStep,
    wizardKey,
    wizardProvider,
    runtime.config.provider,
    validateKey,
    saveConfig,
  ]);

  return (
    <Box flexDirection="column">
      {/* Printed once and left in scrollback. */}
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
          return (
            <TranscriptTurn
              key={item.id}
              turn={item}
              palette={palette}
              color={color}
              showReasoning={showReasoning}
              toolViews={(item.toolCalls ?? []).map((call, index) => ({
                id: `${item.id}-tool-${index}`,
                name: call.name,
                command: call.command,
                status: call.ok ? ('succeeded' as const) : ('failed' as const),
                detail: call.detail,
                durationMs: call.durationMs,
              }))}
              expandedIds={expandedTools}
              focusedTool={null}
              onToggleTool={(toolId) => {
                setExpandedTools((previous) => {
                  const next = new Set(previous);
                  if (next.has(toolId)) next.delete(toolId);
                  else next.add(toolId);
                  return next;
                });
              }}
            />
          );
        }}
      </Static>

      {registryNotice === undefined ? null : (
        <Box marginBottom={1}>
          <Text {...tint(color ? palette.caution : undefined)}>
            {registryNotice}
          </Text>
        </Box>
      )}

      {liveNotice !== '' ? (
        <Box flexDirection="column" marginBottom={1}>
          {liveNotice.split('\n').map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </Box>
      ) : null}

      {pendingTurn === null ? null : (
        <TranscriptTurn
          turn={pendingTurn}
          palette={palette}
          color={color}
          toolViews={toolBlocks}
          expandedIds={expandedTools}
          focusedTool={focusedTool}
          onToggleTool={(toolId) => {
            setExpandedTools((previous) => {
              const next = new Set(previous);
              if (next.has(toolId)) next.delete(toolId);
              else next.add(toolId);
              return next;
            });
          }}
          hideUser
        />
      )}

      {queue.length > 0 ? (
        <Box>
          <Text {...tint(color ? palette.inkFaint : undefined)}>
            {queue.length} prompt
            {queue.length === 1 ? '' : 's'} queued
          </Text>
        </Box>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          query={inputRef.current}
          palette={palette}
          color={color}
          onSelect={chooseCommand}
          onDismiss={() => {
            setModal('none');
          }}
        />
      ) : null}

      {modal === 'confirm' && gate !== null ? (
        <ConfirmModal
          palette={palette}
          color={color}
          command={gate.command}
          {...(gate.reason === undefined ? {} : { reason: gate.reason })}
          onChoose={(choice) => {
            closeGate(choice === 'approve' ? 'approve' : 'deny');
          }}
        />
      ) : null}

      {modal === 'autonomy' ? (
        <AutonomyModal
          palette={palette}
          color={color}
          current={autonomyLevel}
          step={autonomyStep}
          index={autonomyIndex}
          typed={autonomyTyped}
          onIndex={setAutonomyIndex}
          onStep={setAutonomyStep}
          onTyped={setAutonomyTyped}
          onLevel={(level) => {
            // Persist immediately: friction is spent choosing, not saving.
            void saveAutonomy(runtime.assistantConfig.homeDirectory, level);
            setAutonomyLevel(level);
            setModal('none');
            setLiveNotice(`autonomy level set to ${level}`);
          }}
          onCancel={() => {
            setModal('none');
          }}
        />
      ) : null}

      {modal === 'model' ? (
        <ModelPicker
          palette={palette}
          color={color}
          groups={modelGroups}
          activeModel={model}
          notice={registryNotice ?? registryMeta}
          onSelect={(provider, chosen) => {
            runtime.session.setModel(chosen);
            setModelState(chosen);
            setModal('none');
            setLiveNotice(`model switched to ${chosen} (${provider})`);
          }}
          onCancel={() => {
            setModal('none');
          }}
        />
      ) : null}

      {modal === 'init' ? (
        <InitWizard
          palette={palette}
          color={color}
          step={wizardStep}
          providerIndex={wizardProvider}
          selectedLabel={wizardRows[wizardIndex]?.label}
          model={model}
          maskedKey={maskKey(wizardKey)}
          message={wizardMessage}
          rows={wizardRows}
          index={wizardIndex}
          query={wizardQuery}
          onQueryChange={(value) => {
            setWizardQuery(value);
            // Filtering changes which row is highlighted, so the selection
            // resets rather than pointing at an arbitrary survivor.
            setWizardIndex(0);
          }}
          endpoint={wizardEndpoint}
          onEndpointChange={setWizardEndpoint}
          onProvider={(next) => {
            setWizardIndex(
              wizardRows.length === 0
                ? 0
                : ((next % wizardRows.length) + wizardRows.length) %
                    wizardRows.length,
            );
          }}
          onKeyChange={setWizardKey}
          onSubmitKey={() => {
            void submitKey();
          }}
          onCancel={() => {
            // Discard the secret on the way out, whatever stage we cancel at.
            setWizardKey('');
            setModal('none');
          }}
        />
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <StatusBar
          state={state}
          palette={palette}
          color={color}
          animate={motion}
          {...(statusDetail === undefined ? {} : { detail: statusDetail })}
        />
        {descriptor.awaitsUser ? null : (
          <Box marginTop={1}>
            <Composer
              palette={palette}
              color={color}
              state={state}
              value={input}
              enabled={!composerLocked}
            />
          </Box>
        )}
        <Box marginTop={1}>
          <StatusFooter
            palette={palette}
            color={color}
            provider={runtime.config.provider}
            model={model}
            stats={stats}
            {...(contextWindow === undefined ? {} : { contextWindow })}
          />
        </Box>
      </Box>
    </Box>
  );
}

/**
 * A one-line description of a tool call for the status line and tool block.
 *
 * Falls back to the tool name rather than throwing: a malformed argument
 * payload must not take down the interface mid-turn.
 */
function safeDescribe(call: { name: string; arguments: unknown }): string {
  let parsed: Record<string, unknown> = {};
  if (typeof call.arguments === 'string') {
    try {
      const decoded: unknown = JSON.parse(call.arguments);
      if (typeof decoded === 'object' && decoded !== null) {
        parsed = decoded as Record<string, unknown>;
      }
    } catch {
      parsed = { command: call.arguments };
    }
  } else if (typeof call.arguments === 'object' && call.arguments !== null) {
    parsed = call.arguments as Record<string, unknown>;
  }
  try {
    return describeToolCall({ id: '', name: call.name, arguments: parsed });
  } catch {
    return call.name;
  }
}
