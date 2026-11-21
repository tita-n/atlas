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
import { AtlasError, CliInputError, getErrorChain } from './errors.js';
import { AuditLog } from './audit/audit-log.js';
import { loadPermissionConfig } from './config/permission-config.js';
import { setupSudoers } from './permissions/sudoers-setup.js';
import { PermissionGrantStore } from './permissions/grant-store.js';
import { openDatabase } from './memory/database.js';

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
import {
  formatPrice,
  loadRegistry,
  readBundledCache,
  refreshRegistry,
  vendorEndpoint,
  vendorForUrl,
  type ProviderInfo,
} from './providers/model-registry.js';
import { formatTokens } from './tui/tool-blocks.js';
import { runAssistantCommand } from './conversation/assistant-commands.js';
import { canRunTui } from './tui/can-run.js';
import { describeStatus, parseProfile } from './execution/environment.js';
import { resolveExecutionEnvironment } from './execution/resolve-environment.js';
import {
  canonicalize,
  forgetTrust,
  isTrusted,
  loadTrust,
  rememberTrust,
} from './execution/trust.js';
import { initialProfile } from './execution/trust.js';
import {
  disableFullAccess,
  enableFullAccess,
  FULL_ACCESS_PHRASE,
  loadFullAccessGrant,
} from './execution/full-access.js';
import { runVoiceCorrections } from './voice/cli.js';
import { ConversationRepository } from './memory/conversation-repository.js';
import { FactsRepository } from './memory/facts-repository.js';

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

/**
 * First-run wire format choice, as a list.
 *
 * A first run used to be four free-text prompts; every other harness opens on
 * a list, and the wire format is the one choice where the options are fixed,
 * so it is the cheapest place to start showing them.
 */
async function promptWireFormat(): Promise<string> {
  console.log('Wire format:');
  console.log(
    '  1) openai-compatible    OpenAI, DeepSeek, Ollama, vLLM, most gateways',
  );
  console.log('  2) anthropic-compatible Anthropic');
  const answer = await promptText('Provider', '1');
  if (answer === '1') return 'openai-compatible';
  if (answer === '2') return 'anthropic-compatible';
  return answer;
}

/** Base URL prompt, offering the vendors that state an endpoint for it. */
async function promptBaseUrl(
  protocol: ProviderName,
  providers: readonly ProviderInfo[],
): Promise<string> {
  const wantsAnthropic = protocol === 'anthropic-compatible';
  const options = providers
    .flatMap((vendor) => {
      const url = vendorEndpoint(vendor);
      if (url === undefined) return [];
      return /anthropic/i.test(url) === wantsAnthropic ? [{ vendor, url }] : [];
    })
    .slice(0, 12);
  if (options.length > 0) {
    console.log('Providers (largest catalogues first):');
    options.forEach((option, index) => {
      console.log(
        `  ${index + 1}) ${option.vendor.name} — ${option.url} (${option.vendor.models.length} models)`,
      );
    });
  }
  const answer = await promptText(
    'Base URL (number, any URL, or blank for provider default)',
  );
  if (answer === '') return DEFAULT_BASE_URLS[protocol];
  if (/^\d+$/.test(answer)) {
    const picked = options[Number(answer) - 1];
    if (picked === undefined) {
      throw new CliInputError(`No entry ${answer} in the list.`);
    }
    return picked.url;
  }
  return answer;
}

/** Model prompt, offering the chosen vendor's models when one is known. */
async function promptModel(
  vendor: ProviderInfo | undefined,
  defaultValue: string,
): Promise<string> {
  const choices = vendor?.models.slice(0, 12) ?? [];
  if (vendor === undefined || choices.length === 0) {
    return promptText('Model', defaultValue);
  }
  console.log(`Models from ${vendor.name} (largest context first):`);
  choices.forEach((model, index) => {
    const context =
      model.context === 0 ? '' : `  ${formatTokens(model.context)} ctx`;
    const price = ` ${formatPrice(model.pricing) ?? 'no published price'}`;
    console.log(`  ${index + 1}) ${model.id}${context}${price}`);
  });
  const answer = await promptText(
    'Model (number or any model id)',
    defaultValue,
  );
  if (/^\d+$/.test(answer)) {
    const picked = choices[Number(answer) - 1];
    if (picked === undefined) {
      throw new CliInputError(`No entry ${answer} in the list.`);
    }
    return picked.id;
  }
  return answer;
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

  const providerInput = options.provider ?? (await promptWireFormat());
  const providerResult = providerNameSchema.safeParse(providerInput);
  if (!providerResult.success) {
    throw new CliInputError(
      'Provider must be "openai-compatible" or "anthropic-compatible".',
    );
  }
  const provider = providerResult.data;

  // The lists below come from the catalogue shipped with the install, so a
  // first run with no network still opens on providers and models rather than
  // four blank prompts. A fully flagged invocation never touches it.
  const needsCatalogue =
    options.baseUrl === undefined || options.model === undefined;
  const providers = needsCatalogue
    ? (
        await loadRegistry({
          atlasHome: loadAssistantConfig().homeDirectory,
          bundledCache: await readBundledCache(),
        })
      ).snapshot.providers
    : [];

  const baseUrl = options.baseUrl ?? (await promptBaseUrl(provider, providers));
  const vendor = vendorForUrl(providers, baseUrl);
  // A known vendor leads with its own top model, so the blank-enter default
  // matches the endpoint it was picked for; anything else keeps the
  // wire-format default that has always been offered here.
  const defaultModel =
    vendor?.models[0]?.id ??
    (provider === 'openai-compatible' ? 'gpt-4.1-mini' : 'claude-sonnet-4-5');
  const model = options.model ?? (await promptModel(vendor, defaultModel));
  const apiKey = options.apiKey ?? (await promptSecret('API key: '));

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
  console.log('Every provider and model is listed by "atlas models".');
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
    // The protection in force is printed before the first prompt, not buried
    // behind a command. An unsandboxed session the user cannot see is the
    // failure this whole layer exists to prevent.
    onProtectionChange: (status) => {
      console.log(describeStatus(status));
    },
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
    onProtectionChange: (status) => {
      process.stdout.write(`${describeStatus(status)}\n`);
    },
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
  program
    .command('models')
    .description('list the providers and models Atlas can offer')
    .argument('[provider]', 'only show this provider (id or name)')
    .option('--refresh', 'update the catalogue from the network first', false)
    .action(
      async (provider: string | undefined, options: { refresh: boolean }) => {
        const home = loadAssistantConfig().homeDirectory;
        const bundledCache = await readBundledCache();
        if (options.refresh) {
          const outcome = await refreshRegistry({
            atlasHome: home,
            bundledCache,
          });
          if (outcome.error !== undefined) {
            console.error(
              `could not refresh the provider catalogue (${outcome.error}); using the copy on disk`,
            );
          }
        }
        const { snapshot } = await loadRegistry({
          atlasHome: home,
          bundledCache,
        });
        const wanted = provider?.trim().toLowerCase();
        const listed =
          wanted === undefined
            ? snapshot.providers
            : snapshot.providers.filter(
                (entry) =>
                  entry.id.toLowerCase() === wanted ||
                  entry.name.toLowerCase() === wanted,
              );
        const first = listed[0];
        if (first === undefined) {
          console.error(
            wanted === undefined
              ? 'no provider catalogue available'
              : `no provider matches "${provider}"`,
          );
          process.exitCode = 1;
          return;
        }
        if (wanted === undefined) {
          for (const entry of listed) {
            console.log(`${entry.id}  ${entry.models.length} models`);
          }
          const total = snapshot.providers.reduce(
            (sum, entry) => sum + entry.models.length,
            0,
          );
          console.log(
            `${snapshot.providers.length} providers · ${total} models`,
          );
          return;
        }
        console.log(`${first.id} — ${first.models.length} models`);
        for (const model of first.models) {
          const context =
            model.context === 0 ? '' : `  ${formatTokens(model.context)} ctx`;
          const price = ` ${formatPrice(model.pricing) ?? 'no published price'}`;
          console.log(`  ${model.id}${context}${price}`);
        }
      },
    );
  const audit = program
    .command('audit')
    .description('view recent shell permission audit entries')
    .option('--tier <tier>', 'filter by risk tier 0, 1, 2, or 3', parseRiskTier)
    .option(
      '--since <timestamp>',
      'only entries at or after this ISO timestamp',
    )
    .option('--limit <number>', 'maximum entries to show', parseAuditLimit);
  program
    .command('status')
    .description(
      'show the configured provider, model, and active protection mode',
    )
    .action(async () => {
      // Resolves the environment for real rather than reporting a stored
      // setting: "is the sandbox on right now" is a question about this host,
      // in this moment, and only an actual probe answers it.
      const environment = await resolveExecutionEnvironment({
        cwd: process.cwd(),
        atlasHome: loadAssistantConfig().homeDirectory,
        // Same precedence as the runtime: an explicit setting wins, otherwise
        // the trust record decides. Reporting a profile the session would not
        // actually use would make this command worse than useless. Validated,
        // not cast, so `atlas status` refuses a bogus setting the same way a
        // session would rather than reporting a value it cannot honour.
        profile:
          parseProfile(process.env.ATLAS_SANDBOX_PROFILE) ??
          initialProfile(
            await isTrusted(loadAssistantConfig().homeDirectory, process.cwd()),
          ),
        writableRoots: [process.cwd()],
        networkEnabled: process.env.ATLAS_SANDBOX_NETWORK === '1',
        ...(process.env.ATLAS_FULL_ACCESS === '1' ? { forceLocal: true } : {}),
      });
      try {
        const loaded = await loadConfig();
        console.log(`Provider: ${loaded.provider}`);
        console.log(`Model:    ${loaded.model}`);
      } catch {
        console.log('Provider: not configured (run `atlas config init`)');
      }
      console.log(`Protection: ${describeStatus(environment.status)}`);
    });

  const selfmod = addCommonOptions(program.command('selfmod'))
    .description('propose, verify, and apply a change to Atlas itself')
    .argument('<file>', 'JSON file describing the proposed change');

  // Directory trust. workspace-write is a real expansion of what a command can
  // destroy, so the record of who agreed to it lives in Atlas state, outside
  // every mount, and is withdrawable here.
  const trust = program
    .command('trust')
    .description('manage which directories Atlas may write in');
  trust
    .command('list')
    .description('show directories trusted for workspace-write')
    .action(async () => {
      const home = loadAssistantConfig().homeDirectory;
      const entries = await loadTrust(home);
      if (entries.length === 0) {
        console.log(
          'No directories are trusted. Atlas starts read-only everywhere.',
        );
        return;
      }
      for (const entry of entries) {
        console.log(`${entry.path}  (since ${entry.trustedAt})`);
      }
    });
  trust
    .command('add')
    .description('trust a directory for workspace-write')
    .argument('[path]', 'directory to trust', '.')
    .action(async (path: string) => {
      const home = loadAssistantConfig().homeDirectory;
      const canonical = await canonicalize(path);
      try {
        await rememberTrust(home, canonical);
      } catch (error) {
        // Refusing `/` is the expected failure here, so name it rather than
        // letting a raw throw reach the user as a stack trace.
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }
      console.log(`Trusted for workspace-write: ${canonical}`);
      console.log(
        'Atlas state and secrets stay outside the sandbox regardless of this.',
      );
    });
  trust
    .command('remove')
    .description('withdraw trust from a directory')
    .argument('[path]', 'directory to untrust', '.')
    .action(async (path: string) => {
      const home = loadAssistantConfig().homeDirectory;
      const canonical = await canonicalize(path);
      await forgetTrust(home, canonical);
      console.log(`No longer trusted: ${canonical}`);
    });
  trust
    .command('status')
    .description('show whether the current directory is trusted')
    .action(async () => {
      const home = loadAssistantConfig().homeDirectory;
      const canonical = await canonicalize(process.cwd());
      const ok = await isTrusted(home, canonical);
      console.log(`Directory: ${canonical}`);
      console.log(
        `Trusted:   ${ok ? 'yes (workspace-write)' : 'no (read-only)'}`,
      );
    });

  // Full access. The one mode with no sandbox at all, so it is enabled by a
  // typed phrase and recorded with a digest outside every mount. The record,
  // not an environment variable, is what the resolver consults.
  const fullAccess = program
    .command('full-access')
    .description('enable or disable running with no sandbox (full access)');
  fullAccess
    .command('enable')
    .description('enable full access after typing the confirmation phrase')
    .option('--phrase <phrase>', 'the confirmation phrase, for scripting')
    .action(async (opts: { phrase?: string }) => {
      const home = loadAssistantConfig().homeDirectory;
      const phrase =
        opts.phrase ??
        (await promptText(`Type "${FULL_ACCESS_PHRASE}" to confirm: `));
      try {
        const record = await enableFullAccess(home, phrase);
        console.log('Full access ENABLED.');
        console.log(`Since: ${record.enabledAt}`);
        console.log(
          'Atlas will now run commands directly on this computer with no ' +
            'sandbox. The text-based safety checks are a best-effort heuristic ' +
            'and are known to be bypassable in this mode.',
        );
        console.log('Disable it with: atlas full-access disable');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
  fullAccess
    .command('disable')
    .description('disable full access (recommended)')
    .action(async () => {
      const home = loadAssistantConfig().homeDirectory;
      await disableFullAccess(home);
      console.log('Full access DISABLED. Atlas starts in the sandbox again.');
    });
  fullAccess
    .command('status')
    .description('show whether full access is enabled')
    .action(async () => {
      const home = loadAssistantConfig().homeDirectory;
      const grant = await loadFullAccessGrant(home);
      console.log(
        grant === null
          ? 'Full access: OFF'
          : `Full access: ON (since ${grant.enabledAt})`,
      );
    });

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
    // The pre-Phase-4 `runChat` loop was deleted: it owned a HOST shell, never
    // resolved an execution environment, and recorded no sandbox context. It was
    // already unreachable (no `--raw-chat` option was ever registered), and a
    // dead path that runs unconfined is a trap for whoever wires it back up.
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
  selfmod.action(async (file: string) => {
    const { runSelfmodCommand } = await import('./selfmod/cli.js');
    const exitCode = await runSelfmodCommand({ file, root: process.cwd() });
    if (exitCode !== 0) process.exitCode = exitCode;
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
