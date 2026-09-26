# Atlas

Atlas is a small, provider-agnostic command-line AI assistant harness. It is a harness rather than a model: it presents one library interface over OpenAI-compatible and Anthropic-compatible chat APIs, while keeping provider-specific request and response formats inside their adapters.

Phase 2 provides:

- An interactive multi-turn `atlas chat` REPL.
- Structured tool calling for shell requests, with no prose-to-command guessing.
- OpenAI Chat Completions support for OpenAI, Ollama, LM Studio, vLLM, and other compatible endpoints.
- Anthropic Messages support for Anthropic and compatible endpoints.
- JSON configuration at `~/.atlas/config.json`.
- Persistent SQLite memory and shell audit history at `~/.atlas/atlas.db`.
- A persistent bash session for the lifetime of one Atlas process.
- Hard-deny, confirmation, informational, and Tier 0 command policies.
- Explicit `atlas permissions setup` for the narrow passwordless dnf allowlist.
- Automatic conversation resume and durable fact extraction.
- Environment and CLI overrides with the precedence `CLI > environment > file`.
- A publishable npm package with a library entry point and `atlas` binary.
- Unit and integration tests that never call a real provider.

## Requirements

- Node.js 20 or newer
- npm

No API key is stored in this repository. Atlas writes the local configuration file with owner-only permissions where the operating system supports them.

## Install

From a local checkout:

```sh
npm install
npm run build
npm link
atlas --help
```

For a published package, the equivalent global install is:

```sh
npm install --global atlas
```

## Configuration

Run the interactive initializer:

```sh
npx atlas config init
```

It writes `~/.atlas/config.json`. The file uses JSON deliberately: JSON is built into Node, easy to edit, and avoids adding a YAML runtime dependency to the package. A minimal file looks like this:

```json
{
  "provider": "openai-compatible",
  "apiKey": "replace-with-your-key",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4.1-mini"
}
```

`baseUrl` may be omitted when using the provider's default API root. The defaults are:

| Provider               | Default base URL               | Endpoint            |
| ---------------------- | ------------------------------ | ------------------- |
| `openai-compatible`    | `https://api.openai.com/v1`    | `/chat/completions` |
| `anthropic-compatible` | `https://api.anthropic.com/v1` | `/messages`         |

The optional `maxTokens` and `temperature` fields control generation defaults. `temperature` must be between `0` and `2`.

### Environment overrides

Environment variables override values from the config file:

```sh
export ATLAS_PROVIDER=openai-compatible
export ATLAS_API_KEY="your-key"
export ATLAS_BASE_URL="http://localhost:11434/v1"
export ATLAS_MODEL="llama3.2"
export ATLAS_MAX_TOKENS=512
export ATLAS_TEMPERATURE=0.7
atlas chat
```

`ATLAS_CONFIG_PATH` can point to a different JSON file. An API key is never printed by Atlas.

### Interactive chat UX

While Atlas is thinking or a command is running, the REPL shows a spinner with
elapsed time and the command it is running, so a slow turn never looks like a
hang. When output is piped to a file or CI it prints a plain status line
instead.

Shell output is capped before it reaches the model. The default budget is
30,000 characters and a single line is capped at 2,000, keeping the head and
the tail with a visible marker:

```text
[output truncated by Atlas]
Showing the first and last part of 1288895 characters (kept 30000 of 30000 allowed).
```

This stops one command such as `seq 1 200000` from consuming the whole context
window on every later turn. Change the budget with `ATLAS_MAX_TOOL_OUTPUT_CHARS`.

Type `/help` inside the chat for the command list:

| Command      | Purpose                                            |
| ------------ | -------------------------------------------------- |
| `/help`      | Show the available commands.                       |
| `/new`       | Start a fresh conversation.                        |
| `/history`   | List stored conversations.                         |
| `/memory`    | List stored memory facts.                          |
| `/grants`    | List remembered command approvals.                 |
| `/audit [n]` | Show recent permission decisions.                  |
| `/status`    | Show the active provider, model, and conversation. |
| `/exit`      | Leave Atlas.                                       |

`Ctrl+C` cancels the turn that is running and keeps the session and its
history. Press it again while idle to exit. A running command is stopped as
part of the cancel.

If the model keeps calling tools without finishing, Atlas asks it to summarize
what it found instead of failing the turn.

### Running Atlas locally

From the project checkout, run the CLI through `npx`:

```sh
npx atlas chat
```

`atlas` is not a built-in npm command, so `npm atlas chat` and `npm run atlas` do not work. Use `npx atlas ...` (or `npm exec atlas ...`) for a local checkout, and plain `atlas ...` for a global install.

### CLI overrides

CLI flags override both the file and environment:

```sh
atlas chat \
  --provider anthropic-compatible \
  --model claude-sonnet-4-5 \
  --api-key "$ANTHROPIC_API_KEY"
```

Use `--base-url` for a self-hosted endpoint, for example:

```sh
atlas chat --provider openai-compatible --base-url http://localhost:1234/v1 --model local-model
```

The full precedence order is:

```text
CLI flags > ATLAS_* environment variables > ~/.atlas/config.json > provider defaults
```

`--debug` shows the underlying error stack when developing. Without it, CLI errors are readable and do not show raw stack traces.

## CLI

Start a multi-turn conversation:

```sh
atlas chat
```

Type a message, then press Enter. Atlas resumes the most recently active conversation and loads its last 20 messages. It stores the conversation and durable user facts in `~/.atlas/atlas.db`, so a new process starts with the same context. Type `/exit` or press Ctrl+D to leave.

Start a fresh conversation explicitly:

```sh
atlas chat --new
```

Every user and assistant message is written immediately. If the process stops during a provider request, the user message and all earlier completed turns remain in SQLite. Atlas also performs a small asynchronous fact-extraction call after each successful turn; the main response is shown without waiting for that extra call.

The first time Atlas starts, it creates `~/.atlas/atlas.db` with owner read/write permissions and applies the numbered SQL migrations in `migrations/`. The local store uses synchronous `better-sqlite3` calls because Atlas is a single-user CLI and this avoids async overhead for short local reads and writes. Set `ATLAS_DB_PATH` to use a different database file for development or testing.

Initialize or replace configuration:

```sh
atlas config init
atlas config init --force --provider openai-compatible --model gpt-4.1-mini
```

The initializer prompts for the API key without echoing it.

## Memory and history commands

List durable facts:

```sh
atlas memory list
```

Delete one fact by its numeric ID:

```sh
atlas memory forget 3
```

Delete all facts after confirmation:

```sh
atlas memory clear
```

List persisted conversations with their IDs, start dates, and message counts:

```sh
atlas history
```

Conversation, fact, and shell-audit data is local to the SQLite file. Phase 2 does not synchronize it across devices.

## Shell execution and permissions

Atlas exposes one structured `shell` tool to models that support tool calling. The model must return a tool call containing a `command` string. Atlas never extracts commands from ordinary prose, and a model/provider that does not support structured tools cannot trigger execution.

Every attempted command is classified in code before execution:

- Tier 1 is permanently blocked for root deletion, raw-device writes, filesystem formatting, unsafe sudoers writes, firewall disabling, and SELinux disabling.
- Tier 2 requires the typed `ATLAS CONFIRM` phrase after a model-generated explanation.
- Tier 3 shows an explanation and pauses briefly, but does not require a phrase.
- Tier 0 executes immediately.

Rules are glob-style and evaluated in strict `deny -> ask -> allow` order. Built-in hard denies are separate from `~/.atlas/permissions.json` and cannot be overridden by user rules. A user file may add rules but cannot remove built-ins.

Compound commands are parsed into a real Bash AST with the zero-dependency `unbash` package. Atlas recursively classifies pipeline stages, logical branches, subshells, command substitutions, process substitutions, redirections, and supported control-flow bodies. The final decision uses the highest required tier, with deny taking precedence over ask and ask over allow. Unknown executables, malformed syntax, dynamic executable names, and unsupported heredoc traversal fail closed as Tier 2. The model never participates in this decision and receives only the normalized explanation.

A small safe-bin layer recognizes read-only diagnostic profiles for tools such as `ps`, `systemd-cgtop`, `free`, `df`, `du`, `ip` query forms, `ss`, `journalctl` read-only forms, and the small text utilities `cut`, `uniq`, `head`, `tail`, `tr`, and `wc`. A binary must resolve to a canonical system path, its argv must satisfy the tool-specific profile, and the segment must not carry a write redirection. Destructive modes such as `ip addr add` and `journalctl --vacuum-time` remain Tier 2.

Tier 2 approval now offers `ATLAS CONFIRM once`, `ATLAS CONFIRM remember`, or `deny`. Remembering stores exact executable, argv, and working-directory grants in `~/.atlas/permissions.json`. Grants are checked after hard denies and before ordinary rules. Session grants last for the current process; durable grants survive restarts. The grant store refuses persistence for sudo, inline interpreter shells, `bash -c`, `sh -c`, `node -e`, `python -c`, `curl`/`wget` piped into a shell, `xargs`, `dd`, and commands with unresolved substitutions or subshells. Tier 1 hard denies always win, including over crafted grant files.

Manage grants with:

```sh
atlas permissions grants
atlas permissions revoke <grant-id>
```

#### What "remember" accepts

A grant is bound to the resolved executable, the exact argv, and the working directory, so only a command Atlas can pin down exactly is eligible:

- `~` and `$HOME` / `${HOME}` are expanded to a literal path so `find $HOME -name x` can be remembered. Single-quoted `'$HOME'` stays literal, which is exactly what the shell passes.
- The executable may live anywhere it genuinely resolves, including a project-local script, because you approved that exact command. Automatic safe-bin approval is the stricter path and still requires a system directory.
- Any other variable, a command substitution, or a nested shell is never expanded, so `cat $OTHER`, `$(pwd)`, and `${HOME:-/tmp}` cannot be remembered.

Refusal messages say what to change, and a refusal never blocks the one-time approval you already gave.

The default dnf policy is intentionally narrow. `dnf install` is Tier 0 only for simple package names and basic flags such as `-y`. Paths, URLs, `.rpm` files, `--nogpgcheck`, repository options, shell metacharacters, and other flags become Tier 2. Arbitrary `sudo` commands are Tier 2.

The shell runs in one long-lived bash process per Atlas process. `cd`, exported variables, and background jobs persist between tool calls in the same process. A full Atlas restart starts a fresh bash process by design; it does not restore a live shell process from disk.

For Tier 2 confirmation, the text stub requires:

```text
ATLAS CONFIRM
```

A user may override the phrase in `~/.atlas/permissions.json`:

```json
{
  "confirmationPhrase": "ATLAS CONFIRM",
  "rules": []
}
```

Phase 3 will replace the text callback with voice and speaker verification without changing the permission engine.

### Passwordless dnf setup

Atlas does not modify sudoers automatically. Run this explicit command when you want the narrow passwordless package-management allowlist:

```sh
atlas permissions setup
```

It explains the change, asks for confirmation, validates a temporary rule with `visudo`, and uses the system `sudo` command for installation. It never stores or encrypts a sudo password.

If a sudo-gated package command is requested before setup, Atlas tells the user to run `atlas permissions setup` and still requires the normal confirmation flow.

## Audit log

Shell attempts are stored in the append-only `audit_log` SQLite table. View them with:

```sh
atlas audit
atlas audit --tier 1
atlas audit --since 2026-01-01T00:00:00.000Z --limit 100
```

Each row includes the command, risk tier, matched rule, permission decision, outcome, exit code, and duration. The application exposes no audit delete or truncate operation. A future supervisor-owned writer can provide stronger tamper resistance when self-modification is introduced.

## Provider examples

### OpenAI-compatible

Real OpenAI:

```json
{
  "provider": "openai-compatible",
  "apiKey": "sk-...",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4.1-mini"
}
```

Ollama or another local OpenAI-compatible server:

```json
{
  "provider": "openai-compatible",
  "apiKey": "local-placeholder",
  "baseUrl": "http://localhost:11434/v1",
  "model": "llama3.2"
}
```

The base URL is the API root, not the full endpoint. Atlas appends `/chat/completions` and sends the standard `Authorization: Bearer ...` header.

### Anthropic-compatible

Real Anthropic:

```json
{
  "provider": "anthropic-compatible",
  "apiKey": "sk-ant-...",
  "baseUrl": "https://api.anthropic.com/v1",
  "model": "claude-sonnet-4-5"
}
```

A self-hosted Anthropic-compatible endpoint can use the same provider with a different `baseUrl`. Atlas sends the standard `x-api-key` and `anthropic-version` headers, moves unified `system` messages to Anthropic's top-level `system` field, and appends `/messages` to the configured base URL.

Switching providers requires changing configuration only. The CLI and conversation manager do not branch on provider wire formats. Provider adapters retry transient transport failures and HTTP 408/429/5xx responses up to two times with bounded backoff; permanent 4xx request/auth/model errors are not retried.

## Programmatic use

The package exports the provider interface, adapters, factory, configuration loader, and conversation manager from `atlas`:

```ts
import { createProvider, loadConfig, Conversation } from 'atlas';

const config = await loadConfig();
const provider = createProvider(config);
const conversation = new Conversation({ model: config.model });

const first = await conversation.send(provider, 'Say hello in one sentence.');
console.log(first.content);

const second = await conversation.send(provider, 'Now make it shorter.');
console.log(second.content);
```

For persistent programmatic use, inject the repositories and build context from facts:

```ts
import {
  buildSystemPrompt,
  Conversation,
  ConversationRepository,
  createProvider,
  FactsRepository,
  loadConfig,
  openDatabase,
} from 'atlas';

const config = await loadConfig();
const provider = createProvider(config);
const database = openDatabase();
const conversations = new ConversationRepository(database);
const facts = new FactsRepository(database);
const conversation = new Conversation({
  model: config.model,
  conversationRepository: conversations,
  buildSystemPrompt: () => buildSystemPrompt(facts.getAllFacts()),
});

await conversation.send(provider, 'Remember that I prefer concise answers.');
await conversation.flush();
database.close();
```

The complete local example is [`examples/basic-chat.ts`](examples/basic-chat.ts). Run it with:

```sh
npm run build
node --import tsx examples/basic-chat.ts "Hello from the example"
```

`Conversation` accepts only the `LLMProvider` interface, so it is reusable outside the CLI. Without repositories it remains in-memory; with `ConversationRepository`, its working history and turns are persisted.

## Development

```sh
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The test suite injects a mocked `fetch` implementation into each provider adapter, uses temporary real SQLite files for persistence and shell tests, and never makes network calls.

## Scope

Phase 2 intentionally does not include conversation compaction, browser automation, voice, wake words, skills, coding-agent orchestration, self-modification, or an orb UI. Those can be layered on the provider, persistence, conversation, and shell interfaces in later phases.
