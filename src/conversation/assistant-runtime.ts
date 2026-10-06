/**
 * Builds the Phase 4 assistant runtime for a front-end to drive.
 *
 * The wiring here — config, provider, per-home lock, database, repositories,
 * permission classifier, shell tool, extractors, session — used to live inline
 * in the `chat` action in `cli.ts`. Extracting it means a second front-end (the
 * TUI) can start the same assistant without copying that wiring and without
 * the two copies drifting apart.
 *
 * This module owns construction and teardown only. It does not change
 * conversation, memory, or permission behavior: every decision below is the
 * same one the inline code made, in the same order.
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { LoadConfigOptions } from '../config/config.js';
import { loadConfig } from '../config/config.js';
import type { AtlasConfig, ConfigOverrides } from '../config/config.schema.js';
import type { AssistantConfig } from '../config/assistant-config.js';
import { loadAssistantConfig } from '../config/assistant-config.js';
import { loadPermissionConfig } from '../config/permission-config.js';
import { sudoersRuleExists } from '../permissions/sudoers-setup.js';
import { PermissionGrantStore } from '../permissions/grant-store.js';
import { RiskClassifier } from '../permissions/risk-classifier.js';
import { ConfirmationFlow } from '../permissions/confirmation-flow.js';
import { hardFloorVerdict, readAutonomySync } from '../permissions/autonomy.js';
import type { TextConfirmationResult } from '../permissions/confirmation-flow.js';
import { createProvider } from '../providers/provider-factory.js';
import type { LLMProvider, ToolCall } from '../providers/provider.interface.js';
import type { ToolExecutor } from '../providers/provider.interface.js';
import { openDatabase } from '../memory/database.js';
import { ConversationRepository } from '../memory/conversation-repository.js';
import { FactsRepository } from '../memory/facts-repository.js';
import { CorrectionsRepository } from '../memory/corrections-repository.js';
import { FactExtractor } from '../memory/fact-extractor.js';
import { CorrectionExtractor } from '../memory/correction-extractor.js';
import { AuditLog } from '../audit/audit-log.js';
import { ShellSession } from '../shell/shell-session.js';
import { ShellTool } from '../shell/shell-tool.js';
import { createAssistantSession } from './session.js';
import type { AssistantSession } from './session.js';

/**
 * Where assistant notices go.
 *
 * `banner` is for notices the plain front-end wraps in blank lines; `line` is
 * for the rest. A graphical front-end renders these into its own chrome rather
 * than stdout, which is the only reason this is injectable.
 */
export interface AssistantNotices {
  readonly line: (message: string) => void;
  readonly banner: (message: string) => void;
}

/** Notices that reproduce the plain front-end's console output exactly. */
export function consoleNotices(): AssistantNotices {
  return {
    line: (message) => {
      console.log(message);
    },
    banner: (message) => {
      console.log(`\n${message}\n`);
    },
  };
}

export interface CreateAssistantRuntimeOptions {
  /** Config path selection, as computed by the caller's `pathOptions`. */
  readonly configOptions: LoadConfigOptions;
  /** Config overrides, as computed by the caller's `compactOverrides`. */
  readonly overrides: ConfigOverrides;
  /** Start a fresh conversation instead of resuming the most recent one. */
  readonly newConversation: boolean;
  /**
   * Asks the user to confirm a gated command.
   *
   * Injected rather than closing over a readline instance so that each
   * front-end owns its own input handling: the plain REPL prompts on stdin, the
   * TUI renders a modal. The returned value is the provider's decision —
   * `'deny'` for hard-block mode.
   */
  readonly requestConfirmation: (
    phrase: string,
  ) => Promise<TextConfirmationResult>;
  /** Notice sink; defaults to plain console output. */
  readonly notices?: AssistantNotices;
  /**
   * Called immediately before a tool executes.
   *
   * Additive and default-no-op: the plain REPL passes nothing. A graphical
   * front-end uses it to move into an "executing" state, which is the only way
   * it can tell a running command from a model still thinking.
   */
  readonly onToolStart?: ((call: ToolCall) => void) | undefined;
}

/** A started assistant runtime, ready to accept turns. */
export interface AssistantRuntime {
  readonly session: AssistantSession;
  readonly assistantConfig: AssistantConfig;
  readonly config: AtlasConfig;
  readonly provider: LLMProvider;
  readonly facts: FactsRepository;
  readonly corrections: CorrectionsRepository;
  /** Conversation being continued, or undefined when a new one was started. */
  readonly resumedConversationId: string | undefined;
  /**
   * Flushes pending memory writes, then releases the lock and closes the
   * database. Safe to call once; later calls are no-ops.
   */
  close(): Promise<void>;
}

/** A lock held by another Atlas process on the same home directory. */
export interface AssistantRuntimeLockConflict {
  readonly locked: true;
  readonly message: string;
  readonly homeDirectory: string;
}

export type CreateAssistantRuntimeResult =
  | { readonly locked: false; readonly runtime: AssistantRuntime }
  | AssistantRuntimeLockConflict;

/**
 * Starts the assistant.
 *
 * Returns a lock conflict instead of throwing when another process already
 * holds this Atlas home, so front-ends can print the explanation themselves.
 */
/** Outcome of trying to take the per-home lock. */
interface LockResult {
  readonly acquired: boolean;
  /** PID recorded in the lock file, when one could be read. */
  readonly holderPid?: number;
  /** Awaited during teardown so removal cannot race process exit. */
  readonly release: () => Promise<void>;
}

/** Whether a process with this pid currently exists. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads the pid a lock file records, if it holds a usable one. */
async function readLockHolder(lockPath: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(lockPath, 'utf8')).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the per-home lock, reclaiming it from a dead process.
 *
 * A crash, `kill -9`, or a closed terminal used to leave the lock behind and
 * block every later launch permanently, because nothing ever checked whether
 * the recorded pid was still alive. Treating a lock whose holder is gone as
 * reclaimable is what makes the lock self-healing instead of a permanent
 * denial of service.
 */
async function acquireLock(lockPath: string): Promise<LockResult> {
  const attempt = async (): Promise<LockResult> => {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid), 'utf8');
      // Owner-only, matching the database and personality files beside it.
      await handle.chmod(0o600).catch(() => undefined);
      return {
        acquired: true,
        release: async (): Promise<void> => {
          // Awaited: a fire-and-forget removal can lose the race against
          // process exit and leave the lock behind, which defeats the guard.
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true });
        },
      };
    } catch {
      const holderPid = await readLockHolder(lockPath);
      if (holderPid === undefined || !isProcessAlive(holderPid)) {
        return {
          acquired: false,
          release: (): Promise<void> => Promise.resolve(),
        };
      }
      return {
        acquired: false,
        holderPid,
        release: (): Promise<void> => Promise.resolve(),
      };
    }
  };

  const first = await attempt();
  if (first.acquired) return first;
  if (first.holderPid !== undefined) return first;

  // The holder is gone (or unreadable): clear it and try once more. A second
  // failure means a live process really does hold it.
  await rm(lockPath, { force: true });
  return attempt();
}

export async function createAssistantRuntime(
  options: CreateAssistantRuntimeOptions,
): Promise<CreateAssistantRuntimeResult> {
  const notices = options.notices ?? consoleNotices();
  const config = await loadConfig({
    ...options.configOptions,
    overrides: options.overrides,
  });
  const assistantConfig = loadAssistantConfig();
  const provider = createProvider(config);

  // One Atlas per home. Two processes would append to the same conversation
  // and produce a transcript the provider rejects on the next request.
  const home = assistantConfig.homeDirectory;
  const lockPath = join(home, 'atlas.lock');
  await mkdir(home, { recursive: true });
  const lock = await acquireLock(lockPath);
  if (!lock.acquired) {
    return {
      locked: true,
      homeDirectory: home,
      message:
        `Another Atlas session already has ${home} open` +
        (lock.holderPid === undefined ? '.\n' : ` (pid ${lock.holderPid}).\n`) +
        'Close it first, or use a different ATLAS_HOME, otherwise the two ' +
        "sessions would corrupt each other's conversation.",
    };
  }
  const releaseLock = lock.release;

  const database = openDatabase(join(home, 'atlas.db'));
  let shellSession: ShellSession | undefined;
  let session: AssistantSession | undefined;
  let closed = false;

  try {
    const conversations = new ConversationRepository(database);
    const facts = new FactsRepository(database);
    const corrections = new CorrectionsRepository(database);
    const permissionConfig = await loadPermissionConfig();
    const grantStore = PermissionGrantStore.fromConfig(permissionConfig);
    const classifier = new RiskClassifier({
      userRules: permissionConfig.rules,
      sudoWhitelistInstalled: await sudoersRuleExists(),
      // When the user has asked to hard-block dangerous commands, durable
      // grants must not quietly re-enable them. Passing no matcher makes every
      // remembered command go through confirmation again.
      ...(assistantConfig.textConfirmMode === 'block'
        ? {}
        : { grantMatcher: grantStore }),
    });

    const confirmationPhrase =
      permissionConfig.confirmationPhrase === undefined ||
      permissionConfig.confirmationPhrase === ''
        ? 'ATLAS CONFIRM'
        : permissionConfig.confirmationPhrase;
    const home = process.env.HOME;

    const confirmation = new ConfirmationFlow({
      provider,
      model: config.model,
      // Unrecoverable actions and edits to Atlas's own safety configuration
      // always stop for a human, whatever the configured level says.
      hardFloor: (command) => hardFloorVerdict(command, { home }).applies,
      // Read at decision time so lowering the level takes effect without a
      // restart. Reading it once at startup made the setting look inert.
      autonomy: () => ({
        level: readAutonomySync(assistantConfig.homeDirectory).level,
      }),
      phrase: confirmationPhrase,
      confirmText: async (): Promise<TextConfirmationResult> => {
        if (assistantConfig.textConfirmMode === 'block') return 'deny';
        return options.requestConfirmation(confirmationPhrase);
      },
      wait: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    shellSession = new ShellSession();
    shellSession.restart();
    const sessionForShell = shellSession;
    const shellTool = new ShellTool({
      session: sessionForShell,
      classifier,
      confirmation,
      auditLog: new AuditLog(database),
      name: 'shell',
      grantStore,
      // Records which gate approved a dangerous command, so the interim
      // typed-safe-word period is reviewable after the fact.
      gatePath:
        assistantConfig.textConfirmMode === 'block'
          ? 'hard-block'
          : 'text-safe-word',
      // Every audit row records the level in force, so an unattended run is
      // distinguishable in review from a supervised one. Also read at write
      // time, so a row is stamped with the level that actually applied.
      autonomy: () => readAutonomySync(assistantConfig.homeDirectory).level,
      // Dry-run reuses the same permission-checked execution path, so a
      // preview cannot become a way around the classifier.
      dryRun: async (command: string): Promise<string> => {
        // Bound to the session already created above, so a preview and a real
        // execution share one working directory.
        const result = await sessionForShell.execute(command);
        return result.stdout + result.stderr;
      },
    });

    const resuming = options.newConversation
      ? undefined
      : conversations.getMostRecentConversation();

    // Delegates to the shell tool and reports the start, so a front-end can
    // show that a command is running. With no observer this is a plain pass
    // through and changes nothing.
    const observedExecutor: ToolExecutor = {
      execute: (call: ToolCall) => {
        options.onToolStart?.(call);
        return shellTool.execute(call);
      },
    };

    const factExtractor = new FactExtractor({
      provider,
      factsRepository: facts,
      model: config.model,
    });
    const correctionExtractor = new CorrectionExtractor({
      provider,
      correctionsRepository: corrections,
      model: config.model,
    });

    session = await createAssistantSession({
      config: assistantConfig,
      provider,
      model: config.model,
      conversationRepository: conversations,
      ...(resuming === undefined ? {} : { conversationId: resuming.id }),
      facts,
      corrections,
      toolExecutor: observedExecutor,
      tools: [shellTool.definition],
      buildSystemPrompt: () => '',
      ...(config.maxTokens === undefined
        ? {}
        : { maxTokens: config.maxTokens }),
      ...(config.temperature === undefined
        ? {}
        : { temperature: config.temperature }),
      // Facts and corrections are written before the turn ends, so neither can
      // evaporate at session close.
      onTurnComplete: (turn) => {
        if (process.env.ATLAS_TRACE === '1')
          console.error(
            '[turn complete]',
            JSON.stringify(turn.userMessage.content).slice(0, 60),
          );
        return Promise.allSettled([
          factExtractor.extractAndStore({
            userContent: turn.userMessage.content,
            assistantContent: turn.assistantMessage.content,
            sourceMessageId: turn.userMessageId ?? null,
          }),
          correctionExtractor.extractAndStore({
            userContent: turn.userMessage.content,
            assistantContent: turn.assistantMessage.content,
            sourceMessageId: turn.userMessageId ?? null,
          }),
        ]).then(() => undefined);
      },
      onPersonalityNotice: (message) => {
        notices.line(message);
      },
      onConfirmNotice: (message) => {
        notices.banner(message);
      },
      onTimeoutNotice: (message) => {
        notices.banner(message);
      },
    });

    const started = session;
    const startedShell = shellSession;
    return {
      locked: false,
      runtime: {
        session: started,
        assistantConfig,
        config,
        provider,
        facts,
        corrections,
        resumedConversationId: resuming?.id,
        close: async (): Promise<void> => {
          if (closed) return;
          closed = true;
          // Facts and corrections are extracted after each turn. Draining that
          // work before closing the database is what stops a correction being
          // lost when the session ends right after it was given.
          await started.flush();
          await releaseLock();
          startedShell.close();
          database.close();
        },
      },
    };
  } catch (error) {
    await releaseLock();
    shellSession?.close();
    database.close();
    throw error;
  }
}
