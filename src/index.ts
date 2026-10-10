export {
  atlasConfigSchema,
  configOverridesSchema,
  DEFAULT_BASE_URLS,
  providerNameSchema,
  type AtlasConfig,
  type ConfigOverrides,
  type ProviderName,
} from './config/config.schema.js';
export {
  getDefaultConfigPath,
  loadConfig,
  resolveConfigPath,
  saveConfig,
  type LoadConfigOptions,
} from './config/config.js';
export {
  AtlasError,
  CliInputError,
  ConfigFileError,
  ConfigNotFoundError,
  MemoryError,
  MemoryOperationError,
  ConfigValidationError,
  ProviderAPIError,
  ProviderNetworkError,
  ProviderRequestError,
  ProviderResponseError,
  getErrorChain,
  type ErrorChainEntry,
  type ProviderNetworkErrorKind,
  PermissionError,
  ShellSessionError,
  ToolExecutionError,
} from './errors.js';
export {
  Conversation,
  type CompletedTurn,
  type ConversationOptions,
} from './conversation/conversation.js';
export {
  buildSystemPrompt,
  DEFAULT_ATLAS_PERSONALITY,
} from './memory/context-builder.js';
export {
  openDatabase,
  getDefaultDatabasePath,
  resolveDatabasePath,
  type MemoryDatabase,
  type MigrationRecord,
  type SqliteDatabase,
} from './memory/database.js';
export {
  ConversationRepository,
  type AppendMessageInput,
  type ConversationRecord,
  type ConversationRepositoryOptions,
  type ConversationSummary,
  type StoredMessage,
} from './memory/conversation-repository.js';
export {
  FactsRepository,
  type FactsRepositoryOptions,
  type MemoryFact,
} from './memory/facts-repository.js';
export {
  getDefaultPermissionsPath,
  loadPermissionConfig,
  resolvePermissionsPath,
  type LoadPermissionConfigOptions,
  type PermissionConfig,
} from './config/permission-config.js';
export {
  DEFAULT_PERMISSION_RULES,
  HARD_DENY_RULES,
} from './permissions/default-rules.js';
export { type CommandResult } from './shell/command-result.js';
export {
  ShellSession,
  type ShellSessionOptions,
} from './shell/shell-session.js';
export { ShellTool, type ShellToolOptions } from './shell/shell-tool.js';
export {
  ConfirmationFlow,
  DEFAULT_CONFIRMATION_PHRASE,
  type ConfirmationChoice,
  type ConfirmationFlowOptions,
  type ConfirmationOutcome,
  type ConfirmationRequest,
  type TextConfirmation,
  type TextConfirmationResult,
} from './permissions/confirmation-flow.js';
export {
  RiskClassifier,
  isSafePackageCommand,
  isSudoWhitelistInstalled,
  type RiskAssessment,
  type RiskClassifierOptions,
} from './permissions/risk-classifier.js';
export {
  RuleEngine,
  commandMatchesPattern,
  type RuleEvaluation,
} from './permissions/rule-engine.js';
export {
  SAFE_BIN_PROFILES,
  isSafeBinSegment,
  matchesSafeBinProfile,
  resolveTrustedExecutablePath,
  type SafeBinProfile,
} from './permissions/safe-bin-profiles.js';
export {
  PermissionGrantStore,
  type GrantMatcher,
  type RememberResult,
} from './permissions/grant-store.js';
export {
  extractParsedShellStructure,
  extractShellStructure,
  type ShellCommandSegment,
  type ShellStructure,
} from './permissions/shell-structure.js';
export {
  setupSudoers,
  sudoersRuleExists,
  type SudoersSetupOptions,
} from './permissions/sudoers-setup.js';
export {
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  maxToolOutputChars,
  truncateToolOutput,
  type TruncatedOutput,
} from './shell/output-limit.js';
export {
  createActivity,
  describeActivity,
  type Activity,
  type ActivityOptions,
} from './cli/activity.js';
export {
  REPL_COMMANDS,
  parseSlashCommand,
  renderHelp,
  type ReplCommand,
} from './cli/repl-commands.js';
export {
  ATLAS_AUDIO,
  WyomingClient,
  WyomingReader,
  WyomingError,
  audioChunkFrame,
  encodeWyomingEvent,
  readWyomingEvent,
  type WyomingAudioFormat,
  type WyomingEvent,
} from './voice/wyoming.js';
export {
  VoicePipeline,
  looksLikeCorrection,
  type CorrectionSink,
  type TranscriptSink,
  type WakeReport,
} from './voice/voice-pipeline.js';
export {
  VoiceprintStore,
  VoiceprintError,
  cosineSimilarity,
  parseVoiceprint,
  voiceprintFingerprint,
  type Voiceprint,
} from './voice/voiceprint-store.js';
export {
  loadVoiceConfig,
  expandUserPath,
  VOICE_HOST,
  DEFAULT_PORTS,
  type VadConfig,
  type VoiceConfig,
  type VoiceConfigOverrides,
} from './config/voice-config.js';
export {
  VoiceCorrectionsRepository,
  type VoiceCorrectionEntry,
} from './memory/voice-corrections-repository.js';
export { AuditLog, type AuditEntry } from './audit/audit-log.js';
export type {
  AuditDecision,
  AuditEntryInput,
  AuditQuery,
} from './audit/audit-log.schema.js';
export {
  permissionConfigSchema,
  permissionDecisionSchema,
  permissionGrantSchema,
  permissionRuleSchema,
  riskTierSchema,
  type PermissionConfigFile,
  type PermissionGrant,
  type PermissionDecision,
  type PermissionRule,
  type RiskTier,
} from './permissions/rules.schema.js';
export {
  FactExtractor,
  parseFactExtraction,
  type ExtractedFact,
  type FactExtractionExchange,
  type FactExtractorOptions,
} from './memory/fact-extractor.js';
export { AnthropicCompatibleProvider } from './providers/anthropic-compatible.js';
export { OpenAICompatibleProvider } from './providers/openai-compatible.js';
export { createProvider } from './providers/provider-factory.js';
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatRole,
  CompletionUsage,
  LLMProvider,
  ProviderDependencies,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutor,
} from './providers/provider.interface.js';
