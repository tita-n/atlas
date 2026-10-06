#!/usr/bin/env node

import { access } from 'node:fs/promises';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';
import { Writable } from 'node:stream';
import { Command, InvalidArgumentError } from 'commander';
import {
  loadConfig,
  resolveConfigPath,
  saveConfig,
  type LoadConfigOptions,
} from './config/config.js';
import {
  DEFAULT_BASE_URLS,
  providerNameSchema,
  type AtlasConfig,
  type ConfigOverrides,
  type ProviderName,
} from './config/config.schema.js';
import { Conversation } from './conversation/conversation.js';
import { createActivity } from './cli/activity.js';
import { describeActivity } from './cli/activity.js';
import {
  looksLikeCommand,
  parseSlashCommand,
  renderHelp,
} from './cli/repl-commands.js';
import { AtlasError, CliInputError, getErrorChain } from './errors.js';
import { AuditLog } from './audit/audit-log.js';
import { loadPermissionConfig } from './config/permission-config.js';
import { ConfirmationFlow } from './permissions/confirmation-flow.js';
import { RiskClassifier } from './permissions/risk-classifier.js';
import { PermissionGrantStore } from './permissions/grant-store.js';
import {
  setupSudoers,
  sudoersRuleExists,
} from './permissions/sudoers-setup.js';
import { ShellSession } from './shell/shell-session.js';
import { ShellTool } from './shell/shell-tool.js';
import { buildSystemPrompt } from './memory/context-builder.js';
import { openDatabase, type MemoryDatabase } from './memory/database.js';

import { createAssistantRuntime } from './conversation/assistant-runtime.js';
import {
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY_LEVEL,
  describeLevel,
  isAutonomyLevel,
  loadAutonomy,
  saveAutonomy,
  confirmationPhraseFor,
  type AutonomyLevel,
} from './permissions/autonomy.js';
import { loadAssistantConfig } from './config/assistant-config.js';
import { runAssistantCommand } from './conversation/assistant-commands.js';
import { canRunTui } from './tui/can-run.js';
import { runVoiceCorrections } from './voice/cli.js';
import { ConversationRepository } from './memory/conversation-repository.js';
import { FactExtractor } from './memory/fact-extractor.js';
import { FactsRepository } from './memory/facts-repository.js';
import { createProvider } from './providers/provider-factory.js';

/** Upper bound on background fact extraction, so /exit cannot stall. */
const EXTRACTION_BUDGET_MS = 8_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VERSION = '0.1.0';

interface GlobalOptions {
  config?: string;
  debug?: boolean;
}

interface ChatOptions extends GlobalOptions {
  provider?: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  new?: boolean;
  /** Use the pre-Phase-4 chat loop. */
  rawChat?: boolean;
}

interface ConfigInitOptions extends GlobalOptions {
  provider?: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  force?: boolean;
}

function parseMaxTokens(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a positive integer.');
  }
  return parsed;
}

function parseTemperature(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new InvalidArgumentError('must be between 0 and 2.');
  }
  return parsed;
}

function parseFactId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a positive integer.');
  }
  return parsed;
}

function parseRiskTier(value: string): 0 | 1 | 2 | 3 {
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1 && parsed !== 2 && parsed !== 3) {
    throw new InvalidArgumentError('must be 0, 1, 2, or 3.');
  }
  return parsed;
}

function parseAuditLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 500) {
    throw new InvalidArgumentError('must be an integer from 1 to 500.');
  }
  return parsed;
}

/** Validates a grant id, which is always a UUID. */
function parseGrantId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidArgumentError('must be a grant UUID.');
  }
  return value;
}

function ask(readline: ReadlineInterface, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Without a close handler, EOF on a non-interactive stdin leaves this
    // promise pending forever, Node reports an unsettled top-level await, and
    // the process dies with the undocumented exit code 13.
    const onClose = (): void => {
      reject(
        new CliInputError(
          'Cannot prompt for input because stdin is not interactive. ' +
            'Supply the value as a flag, or run this command in a terminal.',
        ),
      );
    };
    readline.once('close', onClose);
    readline.once('error', (error: unknown) => {
      readline.removeListener('close', onClose);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    readline.question(query, (answer) => {
      readline.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

class AsyncLineReader {
  readonly #readline: ReadlineInterface;
  readonly #lines: string[] = [];
  readonly #waiters: ((line: string | undefined) => void)[] = [];
  #closed = false;

  public constructor(readline: ReadlineInterface) {
    this.#readline = readline;
    readline.on('line', (line) => {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(line);
      else waiter(line);
    });
    readline.once('close', () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    });
  }

  public next(): Promise<string | undefined> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  public close(): void {
    this.#readline.close();
  }
}

/**
 * Options shared by every front-end that drives the assistant.
 *
 * `chat` and `tui` must accept exactly the same flags, or a user switching
 * between them would find some invocations silently ignored.
 */
function addAssistantOptions(command: Command): Command {
  return addCommonOptions(command)
    .option(
      '--provider <provider>',
      'provider wire format: openai-compatible or anthropic-compatible',
    )
    .option('--api-key <key>', 'override the configured API key')
    .option('--base-url <url>', 'override the configured API root')
    .option('--model <model>', 'override the configured model')
    .option(
      '--max-tokens <number>',
      'override max output tokens',
      parseMaxTokens,
    )
    .option(
      '--temperature <number>',
      'sampling temperature from 0 to 2',
      parseTemperature,
    )
    .option('--new', 'start a fresh conversation', false);
}

function addCommonOptions(command: Command): Command {
  return command
    .option('-c, --config <path>', 'path to the Atlas config file')
    .option('--debug', 'show full error details', false);
}

function compactOverrides(options: {
  provider?: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): ConfigOverrides {
  return {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.maxTokens === undefined
      ? {}
      : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
  };
}

function pathOptions(
  global: GlobalOptions,
  local: GlobalOptions,
): LoadConfigOptions {
  return {
    ...(global.config === undefined && local.config === undefined
      ? {}
      : { configPath: local.config ?? global.config }),
  };
}

function debugOptions(global: GlobalOptions, local: GlobalOptions): boolean {
  return global.debug === true || local.debug === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactDiagnosticText(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}

function printError(error: unknown, debug: boolean): void {
  if (debug && error instanceof Error) {
    console.error(redactDiagnosticText(error.stack ?? error.message));
    for (const entry of getErrorChain(error.cause)) {
      const code = entry.code === undefined ? '' : ` [${entry.code}]`;
      console.error(
        `Caused by: ${redactDiagnosticText(`${entry.name}${code}: ${entry.message}`)}`,
      );
    }
    return;
  }

  if (error instanceof AtlasError) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(`Error: ${errorMessage(error)}`);
  }
}

async function promptText(
  label: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue === undefined ? ': ' : ` [${defaultValue}]: `;
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await ask(readline, `${label}${suffix}`);
    const normalized = answer.trim();
    return normalized === '' && defaultValue !== undefined
      ? defaultValue
      : normalized;
  } finally {
    readline.close();
  }
}

async function promptSecret(label: string): Promise<string> {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({
    input: process.stdin,
    output: sink,
    terminal: process.stdin.isTTY ?? false,
  });

  process.stdout.write(label);
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      readline.once('line', resolve);
      readline.once('close', () => {
        reject(
          new CliInputError('Input closed before an API key was provided.'),
        );
      });
      readline.once('error', reject);
    });
    if (answer.trim() === '') {
      throw new CliInputError('An API key is required.');
    }
    return answer;
  } finally {
    readline.close();
    process.stdout.write('\n');
  }
}

async function confirm(question: string): Promise<boolean> {
  const answer = (await promptText(question)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runConfigInit(
  globalOptions: GlobalOptions,
  options: ConfigInitOptions,
): Promise<void> {
  const pathConfig = pathOptions(globalOptions, options);
  const configPath = resolveConfigPath(pathConfig);

  if (!options.force && (await fileExists(configPath))) {
    const overwrite = await confirm(
      `Configuration already exists at ${configPath}. Overwrite? [y/N]`,
    );
    if (!overwrite) {
      console.log('Configuration was not changed.');
      return;
    }
  }

  const providerInput =
    options.provider ??
    (await promptText(
      'Provider (openai-compatible/anthropic-compatible)',
      'openai-compatible',
    ));
  const providerResult = providerNameSchema.safeParse(providerInput);
  if (!providerResult.success) {
    throw new CliInputError(
      'Provider must be "openai-compatible" or "anthropic-compatible".',
    );
  }
  const provider = providerResult.data;
  const model =
    options.model ??
    (await promptText(
      'Model',
      provider === 'openai-compatible' ? 'gpt-4.1-mini' : 'claude-sonnet-4-5',
    ));
  const apiKey = options.apiKey ?? (await promptSecret('API key: '));
  const baseUrl =
    options.baseUrl ??
    (await promptText(
      'Base URL (blank for provider default)',
      DEFAULT_BASE_URLS[provider],
    ));

  const config: AtlasConfig = {
    provider,
    apiKey,
    baseUrl,
    model,
    ...(options.maxTokens === undefined
      ? {}
      : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
  };

  await saveConfig(configPath, config);
  console.log(`Configuration saved to ${configPath}.`);
}

/** Commands available inside the assistant loop. */

/**
 * The Phase 4 assistant loop.
 *
 * Resumes the most recent conversation unless `--new` is passed, retrieves
 * relevant memory per turn, runs safe shell commands through the Phase 2
 * permission gates, and shows execution detail in a block separate from the
 * conversational narration.
 */
async function runAssistant(
  globalOptions: GlobalOptions,
  options: ChatOptions,
): Promise<void> {
  const debug = debugOptions(globalOptions, options);
  let readline: ReadlineInterface | undefined;

  // Construction and teardown live in the runtime so that another front-end
  // can start the same assistant without duplicating this wiring.
  const started = await createAssistantRuntime({
    configOptions: pathOptions(globalOptions, options),
    overrides: compactOverrides(options),
    newConversation: options.new === true,
    // Confirmation is read off this readline interface, which only exists once
    // the loop below has created it; the call is deferred until a gated
    // command actually needs it.
    requestConfirmation: async (phrase) =>
      new Promise((resolve) => {
        if (readline === undefined) {
          resolve(false);
          return;
        }
        readline.question(
          `Type ${phrase} to run it, anything else to cancel: `,
          (answer) => {
            resolve(answer.trim().toUpperCase() === phrase.toUpperCase());
          },
        );
      }),
  });

  if (started.locked) {
    console.log(started.message);
    return;
  }
  const { runtime } = started;
  const { session, facts, corrections } = runtime;

  try {
    readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    });

    if (runtime.resumedConversationId === undefined) {
      console.log(
        'Started a new conversation. This is saved; run atlas again to resume.',
      );
    } else {
      console.log('Resuming your last conversation.');
    }
    console.log('Type /help for commands, /exit or Ctrl+D to quit.\n');

    for (;;) {
      const line = await prompt(readline, 'atlas> ');
      if (line === undefined) break;
      const command = runAssistantCommand(line, { facts, corrections });
      if (command.kind === 'exit') break;
      if (command.kind === 'output') {
        if (command.text !== '') console.log(command.text);
        continue;
      }
      const message = command.message;

      process.stdout.write('atlas: ');
      try {
        const turn = await session.handleInput(message);
        if (turn.narration === '') {
          // An empty reply is a provider failure, not a real answer. Say so
          // rather than pretending Atlas had nothing to add.
          console.log(
            '(no reply came back from the provider; nothing was learned this turn)',
          );
        } else {
          console.log(turn.narration);
        }
        if (turn.detail !== '') {
          console.log('\n--- execution detail ---');
          console.log(turn.detail);
          console.log('--- end detail ---\n');
        }
      } catch (error) {
        if (debug) printError(error, true);
        else
          console.log(
            `Something went wrong: ${error instanceof AtlasError ? error.message : String(error)}`,
          );
      }
    }
  } finally {
    readline?.close();
    try {
      await runtime.close();
    } catch (error) {
      if (debug) printError(error, true);
    }
  }
}

/**
 * Runs the graphical front-end when it can, and the plain one when it cannot.
 *
 * Falls back rather than refusing: a pipe, a CI job, or a redirected script
 * still gets a working Atlas, just without the interface.
 */
async function runTuiFrontEnd(
  globalOptions: GlobalOptions,
  options: ChatOptions,
): Promise<void> {
  if (!canRunTui()) {
    await runAssistant(globalOptions, options);
    return;
  }
  const { runTui } = await import('./tui/run.js');
  await runTui({
    configOptions: pathOptions(globalOptions, options),
    overrides: compactOverrides(options),
    newConversation: options.new === true,
  });
}

/** Reads one line, resolving undefined when the input stream closes. */
function prompt(
  readline: ReadlineInterface,
  label: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) return;
      done = true;
      readline.off('close', onClose);
      resolve(value);
    };
    const onClose = (): void => {
      finish(undefined);
    };
    readline.once('close', onClose);
    try {
      readline.question(label, (answer) => {
        finish(answer);
      });
    } catch {
      // The interface can close between the check above and the question.
      finish(undefined);
    }
  });
}

async function runChat(
  globalOptions: GlobalOptions,
  options: ChatOptions,
): Promise<void> {
  const config = await loadConfig({
    ...pathOptions(globalOptions, options),
    overrides: compactOverrides(options),
  });
  const provider = createProvider(config);
  const debug = debugOptions(globalOptions, options);
  const database = openDatabase();
  let conversation: Conversation | undefined;
  let readline: ReadlineInterface | undefined;
  let lineReader: AsyncLineReader | undefined;
  let shellSession: ShellSession | undefined;
  const activity = createActivity();
  // Tracks whether a turn is in flight, so Ctrl+C can cancel a turn instead
  // of tearing down the whole session.
  let turnActive = false;
  let turnAbort: AbortController | undefined;
  // Resolves when the current turn is cancelled, so a confirmation prompt
  // blocked on input can be released by Ctrl+C instead of hanging.
  let turnCancelled: Promise<'cancelled'> | undefined;
  // Lines typed while a turn was running that turned out not to be answers to
  // a permission prompt. The REPL replays them once the turn finishes.
  const deferredLines: string[] = [];

  try {
    const conversations = new ConversationRepository(database);
    const permissionConfig = await loadPermissionConfig();
    const grantStore = PermissionGrantStore.fromConfig(permissionConfig);
    const classifier = new RiskClassifier({
      userRules: permissionConfig.rules,
      sudoWhitelistInstalled: await sudoersRuleExists(),
      grantMatcher: grantStore,
    });
    const auditLog = new AuditLog(database);
    shellSession = new ShellSession();
    shellSession.restart();
    readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    });
    lineReader = new AsyncLineReader(readline);
    const facts = new FactsRepository(database);
    const latestConversation =
      options.new === true
        ? undefined
        : conversations.getMostRecentConversation();
    const extractor = new FactExtractor({
      provider,
      factsRepository: facts,
      model: config.model,
    });
    const confirmation = new ConfirmationFlow({
      provider,
      model: config.model,
      ...(permissionConfig.confirmationPhrase === undefined
        ? {}
        : { phrase: permissionConfig.confirmationPhrase }),
      confirmText: async (request) => {
        // The activity line owns the cursor while a turn runs, so it must be
        // cleared before the prompt reads a line, and restored afterwards.
        activity.stop();
        if (request.sudoSetupRequired) {
          console.log(
            'Sudo package setup is not installed. Run "atlas permissions setup" to enable passwordless package management.',
          );
        }
        console.log(`\n${request.explanation}`);
        // The command itself is always shown. A prompt that describes a risk
        // without showing what is being run cannot be approved knowingly.
        console.log(`\nCommand: ${request.command}`);
        if (lineReader === undefined) {
          activity.start('Thinking');
          return 'deny';
        }
        for (;;) {
          process.stdout.write(
            `Type ${request.phrase} once, ${request.phrase} remember, or deny: `,
          );
          const answer =
            turnCancelled === undefined
              ? await lineReader.next()
              : await Promise.race([lineReader.next(), turnCancelled]);
          const normalized = answer?.trim() ?? '';
          if (normalized === `${request.phrase} remember`) {
            activity.start('Thinking');
            return 'remember';
          }
          if (normalized === request.phrase) {
            activity.start('Thinking');
            return 'once';
          }
          if (
            normalized === 'deny' ||
            normalized === 'no' ||
            normalized === 'n'
          ) {
            activity.start('Thinking');
            return 'deny';
          }
          if (answer === undefined || answer === 'cancelled') {
            activity.stop();
            console.log('\nCancelled. Nothing was executed.\n');
            return 'deny';
          }
          // Not an answer: this was a message typed before or during the turn.
          // It is held aside and answered after the turn instead of being
          // consumed here, so nothing the user typed is ever lost.
          deferredLines.push(answer);
          console.log(
            'That was not an approval. Nothing ran, and your message was kept.',
          );
        }
      },
    });
    const shellTool = new ShellTool({
      session: shellSession,
      classifier,
      confirmation,
      auditLog,
      grantStore,
      onNotice: (message) => {
        activity.stop();
        console.log(message);
        if (turnActive) activity.start('Thinking');
      },
      onActivity: (message) => {
        activity.start(`Running ${describeActivity(message)}`);
      },
    });

    const startConversation = (resumeId?: string): Conversation =>
      new Conversation({
        model: config.model,
        ...(config.maxTokens === undefined
          ? {}
          : { maxTokens: config.maxTokens }),
        ...(config.temperature === undefined
          ? {}
          : { temperature: config.temperature }),
        conversationRepository: conversations,
        ...(resumeId === undefined ? {} : { conversationId: resumeId }),
        buildSystemPrompt: () => buildSystemPrompt(facts.getAllFacts()),
        tools: [shellTool.definition],
        toolExecutor: shellTool,
        toolChoice: 'auto',
        onTurnComplete: async (turn) => {
          try {
            // Bounded so quitting right after a turn cannot stall on a slow
            // extraction call. Losing an extracted fact is far better than
            // hanging the exit.
            await Promise.race([
              extractor.extractAndStore({
                userContent: turn.userMessage.content,
                assistantContent: turn.assistantMessage.content,
                sourceMessageId: turn.userMessageId,
              }),
              new Promise((resolve) => {
                setTimeout(resolve, EXTRACTION_BUDGET_MS).unref?.();
              }),
            ]);
          } catch (error) {
            if (debug) printError(error, true);
          }
        },
      });

    conversation = startConversation(latestConversation?.id);

    console.log(`Atlas ${VERSION} - ${config.provider} / ${config.model}`);
    console.log(
      latestConversation === undefined
        ? 'Started a new conversation.'
        : `Resuming conversation ${latestConversation.id}.`,
    );
    console.log('Shell tool enabled; commands are permission-gated.');
    console.log('Type /help for commands, /exit or Ctrl+D to quit.\n');

    let idleSigints = 0;
    const onSigint = (): void => {
      if (turnActive) {
        // Cancel only the current turn; the session and its history survive.
        turnAbort?.abort();
        return;
      }
      idleSigints += 1;
      if (idleSigints === 1) {
        console.log('\nPress Ctrl+C again to exit, or /exit.');
        return;
      }
      // Close the input so the loop ends on its own and the cleanup below
      // still runs; exitCode carries the interrupt status.
      readline?.close();
      process.exitCode = 130;
    };
    // In terminal mode readline consumes Ctrl+C and re-emits it on the
    // readline interface, so the process-level listener never fires. Bind to
    // whichever source this session actually delivers, and only once.
    if (process.stdin.isTTY) {
      readline.on('SIGINT', onSigint);
    } else {
      process.on('SIGINT', onSigint);
    }

    try {
      while (true) {
        readline.setPrompt('atlas> ');
        readline.prompt();
        // Anything typed during the turn that was not a prompt answer is
        // replayed first, so it is never silently dropped.
        const line =
          deferredLines.length > 0
            ? deferredLines.shift()
            : await lineReader.next();
        if (line === undefined) break;
        idleSigints = 0;
        activity.stop();
        const message = line.trim();
        if (message === '/exit' || message === '/quit') break;
        if (message === '') continue;

        const command = parseSlashCommand(message);
        if (command !== undefined) {
          const handled = runReplCommand(command.name, command.argument, {
            conversation,
            database,
            provider: config.provider,
            model: config.model,
            conversationId: conversation?.id ?? latestConversation?.id,
            restartConversation: () => {
              conversation = startConversation();
            },
          });
          if (handled === 'grants') {
            try {
              await runGrantsList();
            } catch (error) {
              printError(error, false);
            }
          } else if (handled === 'unknown') {
            console.log(
              `Unknown command /${command.name}. Type /help to see what is available.`,
            );
          }
          continue;
        }
        if (message.startsWith('/')) {
          console.log(
            'Commands start with a name, for example /help. Type /help to see all of them.',
          );
          continue;
        }
        if (looksLikeCommand(message)) continue;

        turnActive = true;
        turnAbort = new AbortController();
        turnCancelled = new Promise<'cancelled'>((resolve) => {
          turnAbort?.signal.addEventListener(
            'abort',
            () => {
              resolve('cancelled');
            },
            { once: true },
          );
        });
        shellTool.setAbortSignal(turnAbort.signal);
        activity.start('Thinking');
        try {
          const response = await conversation.send(provider, message, {
            signal: turnAbort.signal,
          });
          activity.stop();
          const text = response.content.trim();
          console.log(
            text === ''
              ? '\natlas: (no text in the response)\n'
              : `\natlas: ${response.content}\n`,
          );
        } catch (error) {
          activity.stop();
          if (turnAbort.signal.aborted) {
            console.log(
              '\natlas: stopped. Nothing was lost; ask again to retry.\n',
            );
          } else {
            printError(error, debug);
            console.log('');
          }
        } finally {
          turnActive = false;
          turnAbort = undefined;
          turnCancelled = undefined;
          shellTool.setAbortSignal(undefined);
        }
      }
    } finally {
      readline.removeListener('SIGINT', onSigint);
      process.removeListener('SIGINT', onSigint);
      readline.close();
    }
    // Deliberately no process.exit() here: it would skip the finally that
    // flushes the conversation and terminates the persistent bash child.
  } finally {
    await conversation?.flush();
    shellSession?.close();
    database.close();
  }
}

/** Outcome of handling a slash command inside the REPL. */
type ReplCommandResult = 'handled' | 'unknown' | 'grants';

function runReplCommand(
  name: string,
  argument: string,
  context: {
    conversation: Conversation | undefined;
    database: MemoryDatabase;
    provider: string;
    model: string;
    conversationId: string | undefined;
    restartConversation: () => void;
  },
): ReplCommandResult {
  switch (name) {
    case 'help': {
      console.log(renderHelp());
      return 'handled';
    }
    case 'new':
    case 'clear':
    case 'reset': {
      // Clearing memory alone would leave the model on a fresh history while
      // the stored conversation still held the old messages, so a real new
      // conversation is started instead.
      context.restartConversation();
      console.log('Started a new conversation.');
      return 'handled';
    }
    case 'history': {
      const conversations = new ConversationRepository(
        context.database,
      ).listConversations();
      if (conversations.length === 0) {
        console.log('No conversations stored.');
        return 'handled';
      }
      for (const entry of conversations) {
        // The comparison must be parenthesised: `+` binds tighter than `===`,
        // so the previous form compared a whole sentence to a bare id and
        // always printed an empty line.
        const isCurrent = entry.id === context.conversationId;
        console.log(
          `${entry.id}  ${formatDate(entry.startedAt)}  ` +
            `${entry.messageCount} message${entry.messageCount === 1 ? '' : 's'}` +
            (isCurrent ? '  (current)' : ''),
        );
      }
      return 'handled';
    }
    case 'memory': {
      const facts = new FactsRepository(context.database).getAllFacts();
      if (facts.length === 0) {
        console.log('No memory facts stored.');
        return 'handled';
      }
      for (const fact of facts) {
        const category = fact.category === null ? '' : ` [${fact.category}]`;
        console.log(`${fact.id}${category}: ${fact.content}`);
      }
      return 'handled';
    }
    case 'grants':
      // Fire-and-forget would print after the next prompt, and could be lost
      // entirely at /exit, so this path is awaited by the caller.
      return 'grants';
    case 'audit': {
      const parsed = Number.parseInt(argument, 10);
      runAudit({
        limit: Number.isFinite(parsed) && parsed > 0 ? parsed : 10,
      });
      return 'handled';
    }
    case 'status': {
      console.log(`Provider: ${context.provider}`);
      console.log(`Model:    ${context.model}`);
      console.log(
        `Chat:     ${context.conversationId ?? 'none (new conversation)'}`,
      );
      return 'handled';
    }
    default:
      return 'unknown';
  }
}

function runMemoryList(): void {
  const database = openDatabase();
  try {
    const facts = new FactsRepository(database).getAllFacts();
    if (facts.length === 0) {
      console.log('No memory facts stored.');
      return;
    }
    for (const fact of facts) {
      const category = fact.category === null ? '' : ` [${fact.category}]`;
      console.log(`${fact.id}${category}: ${fact.content}`);
    }
  } finally {
    database.close();
  }
}

function runMemoryForget(id: number): void {
  const database = openDatabase();
  try {
    const deleted = new FactsRepository(database).deleteFact(id);
    console.log(
      deleted
        ? `Deleted memory fact ${id}.`
        : `Memory fact ${id} was not found.`,
    );
  } finally {
    database.close();
  }
}

async function runMemoryClear(): Promise<void> {
  const confirmed = await confirm('Delete ALL stored memory facts? [y/N]');
  if (!confirmed) {
    console.log('Memory was not changed.');
    return;
  }

  const database = openDatabase();
  try {
    const deleted = new FactsRepository(database).clearFacts();
    console.log(`Deleted ${deleted} memory fact${deleted === 1 ? '' : 's'}.`);
  } finally {
    database.close();
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function runHistory(): void {
  const database = openDatabase();
  try {
    const conversations = new ConversationRepository(
      database,
    ).listConversations();
    if (conversations.length === 0) {
      console.log('No conversations stored.');
      return;
    }
    for (const conversation of conversations) {
      console.log(
        `${conversation.id}  ${formatDate(conversation.startedAt)}  ` +
          `${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}`,
      );
    }
  } finally {
    database.close();
  }
}

/**
 * Shows or sets the autonomy level.
 *
 * Raising or keeping the default level is frictionless. Lowering it requires
 * the user to read what is being given up and type a specific phrase, because
 * this is the one setting where a mis-click has consequences that persist.
 */
async function runAutonomy(options: {
  level?: string;
  confirm?: boolean;
  home: string;
}): Promise<void> {
  const atlasHome = options.home;
  const current = await loadAutonomy(atlasHome);

  if (options.level === undefined) {
    console.log(`Autonomy level: ${current.level}`);
    console.log(
      `  ${describeLevel(current.level).label} - ${describeLevel(current.level).risk}`,
    );
    if (current.level !== DEFAULT_AUTONOMY_LEVEL) {
      console.log('');
      console.log('It persists until you change it back with:');
      console.log(`  atlas autonomy --level ${DEFAULT_AUTONOMY_LEVEL}`);
    }
    return;
  }

  if (!isAutonomyLevel(options.level)) {
    console.error(`Unknown autonomy level: ${options.level}`);
    console.error(`Choose one of: ${AUTONOMY_LEVELS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const target: AutonomyLevel = options.level;
  if (target === current.level) {
    console.log(`Autonomy level is already ${target}.`);
    return;
  }

  const described = describeLevel(target);
  // Lowering past the default is the risky direction and gets the ceremony.
  // Raising it back is deliberately frictionless so recovering is easy.
  const isLowering =
    AUTONOMY_LEVELS.indexOf(target) > AUTONOMY_LEVELS.indexOf(current.level);
  if (isLowering && described.requiresFriction) {
    const phrase = confirmationPhraseFor(target);
    console.log('');
    console.log(`About to set autonomy to: ${described.label}`);
    console.log('');
    console.log(`  ${described.risk}`);
    console.log('');
    console.log('Unrecoverable actions still stop for you either way:');
    console.log('  - wiping a disk or a filesystem root');
    console.log('  - deleting your home directory');
    console.log("  - editing Atlas's own permission or safety configuration");
    console.log('');
    if (options.confirm === true) {
      console.error('Refusing to lower autonomy non-interactively.');
      process.exitCode = 1;
      return;
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    });
    const answer = await ask(rl, `Type "${phrase}" to continue: `);
    rl.close();
    if (answer.trim() !== phrase) {
      console.log('Autonomy level unchanged.');
      return;
    }
  }

  await saveAutonomy(atlasHome, target);
  console.log(`Autonomy level set to ${target}.`);
  if (target !== DEFAULT_AUTONOMY_LEVEL) {
    console.log('It stays that way until you change it back.');
  }
}

function runAudit(options: {
  tier?: 0 | 1 | 2 | 3;
  since?: string;
  limit?: number;
}): void {
  const database = openDatabase();
  try {
    const entries = new AuditLog(database).list({
      ...(options.tier === undefined ? {} : { tier: options.tier }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (entries.length === 0) {
      console.log('No audit entries found.');
      return;
    }
    for (const entry of entries) {
      console.log(
        `${entry.timestamp}  tier=${entry.riskTier}  ` +
          `${entry.decision}  ${entry.matchedRule}  ${entry.outcome}`,
      );
      console.log(`  ${entry.command}`);
    }
  } finally {
    database.close();
  }
}

async function runPermissionsSetup(): Promise<void> {
  console.log(
    'This will validate and install /etc/sudoers.d/atlas for the current user.',
  );
  console.log(
    'It grants passwordless access only to dnf install, dnf update, and dnf check-update.',
  );
  const confirmed = await confirm('Install the scoped sudoers rule? [y/N]');
  if (!confirmed) {
    console.log('Permission setup was not changed.');
    return;
  }
  await setupSudoers();
  console.log('Atlas package-management permissions are installed.');
}

async function runPermissionGrants(): Promise<void> {
  await runGrantsList();
}

/** Lists durable grants. Shared by the CLI subcommand and the REPL. */
async function runGrantsList(): Promise<void> {
  const config = await loadPermissionConfig();
  const grants = PermissionGrantStore.fromConfig(config).listDurable();
  if (grants.length === 0) {
    console.log('No durable permission grants.');
    return;
  }
  for (const grant of grants) {
    console.log(
      `${grant.id}  ${grant.executablePath}  ${grant.argv.join(' ')}  (${grant.cwd})`,
    );
  }
  console.log('Revoke one with: atlas permissions revoke <id>');
}

async function runPermissionRevoke(id: string): Promise<void> {
  const config = await loadPermissionConfig();
  const store = PermissionGrantStore.fromConfig(config);
  const revoked = await store.revoke(id);
  if (revoked) {
    console.log(`Revoked permission grant ${id}.`);
    return;
  }
  console.log(`Grant ${id} was not found.`);
  process.exitCode = 1;
}

/** Builds and runs the Atlas command-line interface. */
export async function main(argv = process.argv): Promise<void> {
  const program = new Command();
  program
    .name('atlas')
    .description('A provider-agnostic terminal AI assistant')
    .version(VERSION)
    .option('-c, --config <path>', 'path to the Atlas config file')
    .option('--debug', 'show full error details', false);

  const chat = addAssistantOptions(program.command('chat')).description(
    'start an interactive multi-turn chat (plain text)',
  );

  // Explicit alias for the graphical front-end, which is also what bare
  // `atlas` runs when stdout is interactive.
  const tui = addAssistantOptions(program.command('tui')).description(
    'start the interactive terminal interface',
  );

  const memory = program.command('memory').description('manage durable memory');
  const memoryList = memory.command('list').description('list stored facts');
  const memoryForget = memory
    .command('forget')
    .description('delete one stored fact')
    .argument('<id>', 'fact id', parseFactId);
  const memoryClear = memory
    .command('clear')
    .description('delete all stored facts');
  const history = program
    .command('history')
    .description('list persisted conversations');
  const audit = program
    .command('audit')
    .description('view recent shell permission audit entries')
    .option('--tier <tier>', 'filter by risk tier 0, 1, 2, or 3', parseRiskTier)
    .option(
      '--since <timestamp>',
      'only entries at or after this ISO timestamp',
    )
    .option('--limit <number>', 'maximum entries to show', parseAuditLimit);
  const autonomy = addCommonOptions(program.command('autonomy'))
    .description('show or set how often Atlas asks before acting')
    .option('--level <level>', `set the level: ${AUTONOMY_LEVELS.join(', ')}`)
    .option(
      '--confirm',
      'acknowledge the change without the typed confirmation (refused when lowering)',
      false,
    );
  const permissions = program
    .command('permissions')
    .description('manage Atlas shell permissions');
  const permissionsSetup = permissions
    .command('setup')
    .description('install the scoped package-management sudoers rule');
  const permissionsGrants = permissions
    .command('grants')
    .description('list durable exact-command approval grants');
  const permissionsRevoke = permissions
    .command('revoke')
    .description('revoke one durable approval grant')
    .argument('<id>', 'grant id', parseGrantId);

  const voice = program
    .command('voice')
    .description('voice input: wake word, speaker verification, and dictation');
  const voiceEnroll = voice
    .command('enroll')
    .description('enroll a voiceprint for voice activation')
    .option('--redo', 'replace an existing enrollment', false)
    .option('--backend <name>', 'voice backend: sherpa-onnx or wyoming');
  const voiceListen = voice
    .command('listen')
    .description('run the always-on wake, verify, and dictation pipeline')
    .option('--backend <name>', 'voice backend: sherpa-onnx or wyoming');
  const voiceTestWake = voice
    .command('test-wake')
    .description('report wake detections and speaker scores without acting')
    .option('--backend <name>', 'voice backend: sherpa-onnx or wyoming')
    .option(
      '--keywords <path>',
      'test the exact keyword lines in this file instead of the generated ones',
    );
  const voiceSetup = voice
    .command('setup-models')
    .description('download and cache the voice models, showing sizes first')
    .option('--backend <name>', 'voice backend: sherpa-onnx or wyoming')
    .option('--yes', 'do not prompt before downloading', false);
  const voiceCorrections = voice
    .command('corrections')
    .description('view logged transcripts and their corrections')
    .option('--limit <number>', 'entries to show', parseAuditLimit);

  const config = program
    .command('config')
    .description('manage Atlas configuration');
  const configInit = addCommonOptions(config.command('init'))
    .description('create ~/.atlas/config.json interactively')
    .option('--force', 'overwrite an existing config without prompting', false)
    .option(
      '--provider <provider>',
      'provider wire format: openai-compatible or anthropic-compatible',
    )
    .option('--api-key <key>', 'use this key instead of prompting')
    .option('--base-url <url>', 'API root written to the config')
    .option('--model <model>', 'model written to the config')
    .option('--max-tokens <number>', 'maximum output tokens', parseMaxTokens)
    .option(
      '--temperature <number>',
      'sampling temperature from 0 to 2',
      parseTemperature,
    );

  chat.action(async () => {
    const global = program.opts<GlobalOptions>();
    const local = chat.opts<ChatOptions>();
    // Phase 4: the assistant loop replaces the raw chat loop.
    if (local.rawChat === true) {
      await runChat(global, local);
      return;
    }
    await runAssistant(global, local);
  });

  tui.action(async () => {
    const global = program.opts<GlobalOptions>();
    const local = tui.opts<ChatOptions>();
    await runTuiFrontEnd(global, local);
  });

  // Bare `atlas`: the graphical interface in a terminal, the plain front-end
  // everywhere else. Piped and scripted use must never get a TUI, and the
  // plain path stays available explicitly as `atlas chat`.
  program.action(async () => {
    const global = program.opts<GlobalOptions>();
    await runTuiFrontEnd(global, { ...program.opts<ChatOptions>() });
  });

  memoryList.action(() => {
    runMemoryList();
  });
  memoryForget.action((id: number) => {
    runMemoryForget(id);
  });
  memoryClear.action(async () => runMemoryClear());
  history.action(() => {
    runHistory();
  });
  autonomy.action(async (options: { level?: string; confirm: boolean }) => {
    const home = loadAssistantConfig().homeDirectory;
    await runAutonomy({
      ...(options.level === undefined ? {} : { level: options.level }),
      confirm: options.confirm,
      home,
    });
  });

  audit.action(
    (options: { tier?: 0 | 1 | 2 | 3; since?: string; limit?: number }) => {
      runAudit(options);
    },
  );
  permissionsSetup.action(async () => runPermissionsSetup());
  voiceEnroll.action(async () => {
    const { runVoiceEnroll } = await import('./voice/cli.js');
    const opts = voiceEnroll.opts<{ redo: boolean; backend?: string }>();
    await runVoiceEnroll({
      redo: opts.redo,
      ...(opts.backend === undefined ? {} : { backend: opts.backend }),
    });
  });
  voiceListen.action(async () => {
    const { runVoiceListen } = await import('./voice/cli.js');
    const opts = voiceListen.opts<{ backend?: string }>();
    await runVoiceListen(
      opts.backend === undefined ? {} : { backend: opts.backend },
    );
  });
  voiceTestWake.action(async () => {
    const { runVoiceTestWake } = await import('./voice/cli.js');
    const opts = voiceTestWake.opts<{ backend?: string; keywords?: string }>();
    await runVoiceTestWake({
      ...(opts.backend === undefined ? {} : { backend: opts.backend }),
      ...(opts.keywords === undefined ? {} : { keywords: opts.keywords }),
    });
  });
  voiceSetup.action(async () => {
    const { runVoiceSetupModels } = await import('./voice/cli.js');
    const opts = voiceSetup.opts<{ backend?: string; yes: boolean }>();
    await runVoiceSetupModels({
      ...(opts.backend === undefined ? {} : { backend: opts.backend }),
      yes: opts.yes,
    });
  });
  voiceCorrections.action(() => {
    runVoiceCorrections(voiceCorrections.opts<{ limit: number }>().limit);
  });

  permissionsGrants.action(async () => runPermissionGrants());
  permissionsRevoke.action(async (id: string) => runPermissionRevoke(id));

  configInit.action(async () => {
    const global = program.opts<GlobalOptions>();
    const local = configInit.opts<ConfigInitOptions>();
    await runConfigInit(global, local);
  });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const debug = process.argv.includes('--debug');
    printError(error, debug);
    process.exitCode = 1;
  }
}

await main();
