'use client';

import { VALIDATION_LIMITS } from '@/lib/utils/app/const';
import { TokenUsageMetadata } from '@/lib/utils/app/metadata';
import { ToolApprovalRule } from '@/lib/utils/shared/chat/toolApprovalRules';
import {
  EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS,
  EMISSIONS_CHIP_VISIBILITY_DEFAULT,
  EmissionsChipVisibility,
  clampEmissionsChipAutoHideMs,
  isEmissionsChipVisibility,
} from '@/lib/utils/shared/emissions';
import {
  DEFAULT_MAP_TIMELAPSE,
  MapTimelapseSettings,
  clampTimelapseSettings,
} from '@/lib/utils/shared/geo/timelapsePacing';
import {
  DEFAULT_PASTE_ATTACHMENT_CHARS,
  clampPasteAttachmentChars,
} from '@/lib/utils/shared/paste/pastedText';
import { UserRegion } from '@/lib/utils/shared/region';

import { InterpreterMode, isInterpreterMode } from '@/types/interpreterMode';
import {
  LOCAL_RUNTIMES,
  LocalRuntime,
  LocalRuntimeStatus,
  isValidPort,
} from '@/types/localRuntime';
import type { M365PickerLocation, M365SaveDestination } from '@/types/m365';
import {
  DEFAULT_MODEL_ORDER,
  ModelListSource,
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
} from '@/types/openai';
import { MSFOrganization } from '@/types/organization';
import { Prompt } from '@/types/prompt';
import { SearchMode } from '@/types/searchMode';
import {
  DEFAULT_STREAMING_SPEED,
  DisplayNamePreference,
  ReasoningEffort,
  StreamingSpeedConfig,
  Verbosity,
} from '@/types/settings';
import { SavedStructure } from '@/types/structure';
import { Tone } from '@/types/tone';
import { DEFAULT_TTS_SETTINGS, TTSSettings } from '@/types/tts';
import {
  DEFAULT_WEB_SEARCH_OPTIONS,
  WebSearchOptions,
  sanitizeWebSearchOptions,
} from '@/types/webSearch';
import {
  CustomTranslationLanguage,
  DocumentCustomCriterion,
  DocumentSpec,
  TranslationCustomCriterion,
  TranslationGlossary,
} from '@/types/workflow';

import { MCP_CATALOG } from '@/config/mcpCatalog';
import { SETTINGS_CONSTANTS } from '@/lib/constants/settings';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Model ordering mode for the model selection UI */
export type ModelOrderMode = 'usage' | 'name' | 'cutoff' | 'custom';

/** Tracks consecutive usage of a model for stability in ordering */
export interface ConsecutiveModelUsage {
  modelId: string | null;
  count: number;
}

export interface ConsecutiveToolUsage {
  toolId: string | null;
  count: number;
}

/** One aggregation bucket of real token usage (see tokenUsageStats). */
export interface TokenUsageBucket {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

/** Builds the tokenUsageStats bucket key for one request's usage. */
export function tokenUsageKey(
  usage: Pick<TokenUsageMetadata, 'modelId' | 'region' | 'reasoningEffort'>,
): string {
  return `${usage.modelId}|${usage.region ?? 'default'}|${usage.reasoningEffort ?? 'none'}`;
}

/** A Foundry project endpoint that the app discovers agents from */
export interface AgentSource {
  id: string;
  name: string; // User-friendly label: "Amsterdam Office", "Geneva Hub"
  resourcePath: string; // ARM resource path to Foundry project
  createdAt: string; // ISO timestamp
  /**
   * When true (default), agents that later appear on the remote project are
   * shown automatically, except those in excludedAgentNames. When false,
   * only selectedAgentNames are shown.
   */
  autoAddNewAgents: boolean;
  /** agentName slugs deselected at connect/edit time (used when autoAddNewAgents). */
  excludedAgentNames: string[];
  /** agentName slugs explicitly selected (used when !autoAddNewAgents). */
  selectedAgentNames: string[];
}

/**
 * A Foundry ACCOUNT the user connected for model discovery ("BYO model
 * sources"). Parallel to AgentSource: the user's own ARM RBAC (via OBO)
 * authorizes browsing and chat — app-level model gating does not apply.
 */
export interface ModelSource {
  id: string; // uuid
  name: string; // user label
  /** ARM account (or project) path; validated client+server, stripped to account. */
  resourcePath: string;
  createdAt: string; // ISO timestamp
  /**
   * When true (default), deployments that later appear on the remote account
   * are shown automatically, except those in excludedModelNames. When false,
   * only selectedModelNames are shown.
   */
  autoAddNewModels: boolean;
  /** deployment names deselected at connect/edit time (used when autoAddNewModels). */
  excludedModelNames: string[];
  /** deployment names explicitly selected (used when !autoAddNewModels). */
  selectedModelNames: string[];
}

export type McpAuthMode = 'none' | 'bearer' | 'header' | 'oauth';

/**
 * Everything OAuth-connected MCP servers need for silent refresh across
 * sessions. Held in memory + the ENCRYPTED credential vault (see
 * client/services/mcp/credentialVault.ts) — the persisted settings blob is
 * secret-redacted. Excluded from exportData(),
 * wiped by resetSettings. Discovery endpoints are deliberately NOT stored:
 * the server re-derives them from RFC 9728/8414 discovery on every proxy
 * call, so nothing here could redirect a credential.
 */
export interface McpOauthState {
  /** Absent while needsReauth. Relayed per request exactly like a PAT. */
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent = unknown → use until a 401 forces reauth. */
  expiresAt?: number;
  scope?: string;
  /** Dynamic-client-registration result — reused on refresh/reconnect. */
  clientId: string;
  /** Some authorization servers issue one even to public clients. */
  clientSecret?: string;
  /** Refresh failed / 401 seen → the row shows "Reconnect". */
  needsReauth?: boolean;
}

/**
 * An MCP server the user has connected ("Connectors" settings section).
 * Curated entries (catalogKey set) never store a URL — the server resolves
 * it from config/mcpCatalog.ts, so a tampered/imported localStorage blob
 * can't redirect a token to an attacker URL.
 */
export interface McpServerConfig {
  id: string;
  /** Present ⇒ curated catalog entry ('github' | 'asana' | …). */
  catalogKey?: string;
  /**
   * Present ⇒ admin-authored connector. Like catalogKey the URL is resolved
   * server-side, but resolution ALSO re-checks this user's access rules, so a
   * stale entry for a revoked connector simply stops resolving.
   */
  connectorId?: string;
  name: string;
  /** '' for curated entries and connectors; user-entered https URL otherwise. */
  url: string;
  /** How this server authenticates (mirrors the catalog for curated entries). */
  authMode: McpAuthMode;
  /**
   * Personal access token (bearer/header modes). On-device only: held in
   * memory for the session and at rest in the ENCRYPTED credential vault
   * (client/services/mcp/credentialVault.ts) — partialize redacts it from
   * the persisted localStorage blob. Sent in request bodies, never persisted
   * server-side. XSS caveat: same-origin script injection can still read the
   * in-memory value — the UI steers users toward fine-grained,
   * minimally-scoped tokens. Deliberately excluded from exportData()
   * (see importExport.ts).
   */
  authToken?: string;
  /** OAuth token bundle (oauth mode only). Same privacy posture as authToken. */
  oauth?: McpOauthState;
  /**
   * User-supplied OAuth app for this server ("bring your own app"): the user
   * registers an app in THEIR provider account (their GitHub org, their
   * Asana workspace, their enterprise instance) with redirect URI
   * `{origin}/mcp-oauth-callback` and pastes its credentials here. Takes
   * precedence over dynamic client registration and the deployment-wide
   * MCP_OAUTH_* apps. The secret is the user's own and follows the same
   * on-device (memory + encrypted vault) / body-relay / never-server-
   * persisted posture as PATs.
   */
  oauthApp?: { clientId: string; clientSecret?: string };
  /** Off = keep the config (and token) but stop offering its tools in chat. */
  enabled: boolean;
  createdAt: string; // ISO timestamp
}

export interface CustomAgent {
  id: string;
  name: string;
  agentId: string; // Azure AI Foundry agent ID
  baseModelId: OpenAIModelID;
  description?: string;
  createdAt: string;

  // Team template metadata (optional)
  templateId?: string; // Unique ID of the template this was imported from
  templateName?: string; // Human-readable name of the template
  importedAt?: string; // ISO timestamp when imported from template
}

interface SettingsStore {
  // State
  temperature: number;
  systemPrompt: string;
  defaultModelId: OpenAIModelID | undefined;
  defaultSearchMode: SearchMode;
  /** Advanced web-search tuning (source count, freshness preference). */
  webSearchOptions: WebSearchOptions;
  /** Default code-interpreter mode for new conversations (mirrors defaultSearchMode). */
  defaultInterpreterMode: InterpreterMode;
  autoSwitchOnFailure: boolean;
  displayNamePreference: DisplayNamePreference;
  customDisplayName: string;
  models: OpenAIModel[];
  prompts: Prompt[];
  tones: Tone[];
  customAgents: CustomAgent[];
  customAgentSources: AgentSource[];
  /** BYO Foundry accounts the user connected for model discovery. */
  customModelSources: ModelSource[];
  /**
   * User port overrides for local model runtimes. Only overrides are stored —
   * defaults live in LOCAL_RUNTIME_DEFAULTS. The HOST is never user-editable
   * (always 127.0.0.1), so this is the only persisted value that influences
   * where a local request goes; it is re-validated on rehydrate.
   */
  localRuntimePorts: Partial<Record<LocalRuntime, number>>;
  /**
   * Session-scoped detection results, keyed by runtime. Deliberately NOT
   * persisted: a runtime that was running yesterday tells us nothing about
   * today, and a stale "ready" would offer models that can't answer.
   * Lives in the store rather than the hook because the picker and the
   * settings pane both read it, and the picker unmounts on close.
   */
  localRuntimeStatus: Partial<Record<LocalRuntime, LocalRuntimeStatus>>;
  /** LaunchDarkly `localModels` mirror. Fail-closed; never persisted. */
  localModelsFlagEnabled: boolean;
  /** Reusable terminology glossaries for the translation workflow. */
  glossaries: TranslationGlossary[];
  /** User-added translation target languages (flagged in the picker). */
  customLanguages: CustomTranslationLanguage[];
  /** Reusable document format templates (document workflow). */
  documentSpecs: DocumentSpec[];
  /** User-defined document quality criteria (document workflow). */
  documentCriteria: DocumentCustomCriterion[];
  /** User-defined MQM-style criteria for the translation workflow. */
  translationCriteria: TranslationCustomCriterion[];
  /** MCP servers the user connected (Connectors settings section). */
  mcpServers: McpServerConfig[];
  /**
   * Global MCP tool approval policy: auto-approve / auto-reject rules that
   * apply in EVERY conversation (the per-conversation alwaysApprove* fields
   * layer on top; reject rules beat all approvals). Managed from consent
   * cards and Settings → Connectors.
   */
  toolApprovalRules: ToolApprovalRule[];
  /** User opt-in for adding/sending arbitrary (non-catalog) MCP servers. */
  allowArbitraryMcpServers: boolean;
  /**
   * Runtime-only mirror of the LaunchDarkly `mcpArbitraryServers` flag, set
   * by AppInitializer so vanilla stores (chatStore) can gate without hook
   * access (same pattern as userRegion). Fail-closed: defaults to false and
   * only flips on an explicit `=== true` flag value. NOT persisted.
   */
  mcpArbitraryFlagEnabled: boolean;
  /**
   * Max messages sent per chat request (the "context window"). Defaults to
   * the legacy hard cut (VALIDATION_LIMITS.CLIENT_MAX_MESSAGES); the dropped
   * middle is summarized via conversation compaction instead of silently
   * lost. The setter clamps to 20..200 (server zod rejects >MAX_API_MESSAGES).
   */
  contextWindowSize: number;
  /** User opt-in for cross-conversation Memories (default off). */
  memoriesEnabled: boolean;
  /**
   * Pauses automatic memory CAPTURE while leaving injection untouched: the
   * memories already saved keep reaching the system prompt, but no new ones
   * are extracted. Negative polarity is deliberate — an undefined value
   * (skipped or partial migration) is falsy and so means "behave as before",
   * never "silently stop capturing".
   */
  memoryCapturePaused: boolean;
  /**
   * Runtime-only mirror of the LaunchDarkly `enableMemories` flag, set by
   * AppInitializer so vanilla stores (chatStore) can gate without hook
   * access (same pattern as mcpArbitraryFlagEnabled). Fail-closed: defaults
   * to false and only flips on an explicit `=== true` flag value. NOT
   * persisted.
   */
  memoriesFlagEnabled: boolean;
  /**
   * Model IDs the user has hidden from the picker. Covers base models and
   * agents alike (everything in the picker is keyed by a string model ID:
   * `gpt-5.2`, `org-{id}`, `foundry-{sourceHash}-{id}`). Hiding never deletes —
   * the ID stays here until the user restores it.
   */
  hiddenModelIds: string[];
  /**
   * Model IDs the user has starred (same key space as hiddenModelIds: base
   * models and agents alike). Starred models surface first in the picker's
   * Favorites section. Mutually exclusive with hiddenModelIds — the
   * star/hide actions enforce it, so no UI can create the contradiction.
   */
  starredModelIds: string[];
  /**
   * RAW per-user token usage, accumulated locally (privacy-first: the user's
   * own stats never leave the device; org-level tracking uses the server's
   * TokenUsage log event). Keyed `modelId|region|effort` — bounded
   * cardinality (~models × 3 regions × 5 efforts, realistically <50 keys).
   * Raw counts only: CO2e is computed at DISPLAY time from
   * config/emissions.json so assumption changes apply retroactively.
   */
  tokenUsageStats: Record<string, TokenUsageBucket>;
  /** ISO timestamp of the first recorded usage (display: "since ..."). */
  tokenUsageFirstTrackedAt: string | null;
  /**
   * Usage BACK-CALCULATED from conversations that predate tracking (tokens
   * approximated from stored message text — see usageBackfill.ts). Kept
   * separate from tokenUsageStats so the UI can label the estimated portion.
   * Same key format and raw-counts-only convention as tokenUsageStats.
   */
  estimatedUsageStats: Record<string, TokenUsageBucket>;
  /**
   * ISO timestamp stamped when the one-time historical backfill ran (or was
   * intentionally skipped). Non-null = never run it again — including for
   * conversations imported later (accepted limitation).
   */
  historicalUsageBackfilledAt: string | null;

  /**
   * Provenance of the current `models` list (from /api/models). Runtime-only,
   * not persisted: the UI uses it to suppress region/hosting chrome when the
   * list is static and to note partial discovery.
   */
  modelListSource: ModelListSource | null;
  /**
   * The session user's effective region ('US' | 'EU'), mirrored from
   * next-auth by AppInitializer so vanilla stores (chatStore) can gate model
   * selectability without hook access. Runtime-only, not persisted.
   */
  userRegion: UserRegion | null;
  /**
   * User-defined data structures (Customizations → Structures). Shared: an
   * entry is usable as an extraction recipe and as a data-workflow table
   * schema. Renamed from `extractionRecipes` in v41.
   */
  savedStructures: SavedStructure[];
  streamingSpeed: StreamingSpeedConfig;

  /** Whether to include user info (name, title, email, dept) in system prompt */
  includeUserInfoInPrompt: boolean;

  /** User's preferred name (overrides displayName from profile) */
  preferredName: string;

  /** Additional context about the user for the AI */
  userContext: string;

  // Model ordering state
  modelOrderMode: ModelOrderMode;
  customModelOrder: string[];
  modelUsageStats: Record<string, number>;
  consecutiveModelUsage: ConsecutiveModelUsage;

  // Organization preference for support contacts (null = auto-detect)
  organizationPreference: MSFOrganization | null;

  // Slash menu usage tracking
  slashMenuUsageCounts: Record<string, number>;

  // Chat input "+" dropdown tool personalization
  pinnedToolIds: string[];
  toolUsageCounts: Record<string, number>;
  /** Tools the user explicitly moved into the "More" section. */
  hiddenToolIds: string[];
  /** Default-hidden tools the user explicitly pulled back out of "More". */
  revealedToolIds: string[];
  /** Debounce for usage-based ordering (mirrors consecutiveModelUsage). */
  consecutiveToolUsage: ConsecutiveToolUsage;

  // Text-to-Speech settings
  ttsSettings: TTSSettings;

  // Reasoning model settings
  reasoningEffort: ReasoningEffort | undefined;
  verbosity: Verbosity | undefined;

  // Actions
  setTemperature: (temperature: number) => void;
  setSystemPrompt: (prompt: string) => void;
  setDefaultModelId: (id: OpenAIModelID | undefined) => void;
  setDefaultSearchMode: (mode: SearchMode) => void;
  setWebSearchOptions: (options: Partial<WebSearchOptions>) => void;
  setDefaultInterpreterMode: (mode: InterpreterMode) => void;
  setAutoSwitchOnFailure: (enabled: boolean) => void;
  setDisplayNamePreference: (preference: DisplayNamePreference) => void;
  setCustomDisplayName: (name: string) => void;
  setStreamingSpeed: (config: StreamingSpeedConfig) => void;
  setIncludeUserInfoInPrompt: (enabled: boolean) => void;
  setPreferredName: (name: string) => void;
  setUserContext: (context: string) => void;
  setModels: (models: OpenAIModel[]) => void;
  setPrompts: (prompts: Prompt[]) => void;
  addPrompt: (prompt: Prompt) => void;
  updatePrompt: (id: string, updates: Partial<Prompt>) => void;
  deletePrompt: (id: string) => void;

  // Tone Actions
  setTones: (tones: Tone[]) => void;
  addTone: (tone: Tone) => void;
  updateTone: (id: string, updates: Partial<Tone>) => void;
  deleteTone: (id: string) => void;

  // Custom language actions (translation workflow)
  addCustomLanguage: (language: CustomTranslationLanguage) => void;
  deleteCustomLanguage: (id: string) => void;

  // Document spec / custom criterion actions (document workflow)
  addDocumentSpec: (spec: DocumentSpec) => void;
  updateDocumentSpec: (
    id: string,
    updates: Partial<Omit<DocumentSpec, 'id'>>,
  ) => void;
  deleteDocumentSpec: (id: string) => void;
  addDocumentCriterion: (criterion: DocumentCustomCriterion) => void;
  updateDocumentCriterion: (
    id: string,
    updates: Partial<Omit<DocumentCustomCriterion, 'id'>>,
  ) => void;
  deleteDocumentCriterion: (id: string) => void;
  addTranslationCriterion: (criterion: TranslationCustomCriterion) => void;
  updateTranslationCriterion: (
    id: string,
    updates: Partial<Omit<TranslationCustomCriterion, 'id'>>,
  ) => void;
  deleteTranslationCriterion: (id: string) => void;

  // Glossary Actions (translation workflow)
  addGlossary: (glossary: TranslationGlossary) => void;
  updateGlossary: (
    id: string,
    updates: Partial<Omit<TranslationGlossary, 'id'>>,
  ) => void;
  deleteGlossary: (id: string) => void;

  // Custom Agent Actions
  setCustomAgents: (agents: CustomAgent[]) => void;
  addCustomAgent: (agent: CustomAgent) => void;
  updateCustomAgent: (id: string, updates: Partial<CustomAgent>) => void;
  deleteCustomAgent: (id: string) => void;

  // Agent Source Actions
  addCustomAgentSource: (source: AgentSource) => void;
  updateCustomAgentSource: (source: AgentSource) => void;
  deleteCustomAgentSource: (id: string) => void;

  // Model Source Actions (BYO Foundry accounts)
  addCustomModelSource: (source: ModelSource) => void;
  updateCustomModelSource: (source: ModelSource) => void;
  deleteCustomModelSource: (id: string) => void;

  // Local Runtime Actions (Ollama / LM Studio / llama.cpp)
  /** Sets a port override, or clears it when given undefined. */
  setLocalRuntimePort: (
    runtime: LocalRuntime,
    port: number | undefined,
  ) => void;
  setLocalRuntimeStatus: (
    runtime: LocalRuntime,
    status: LocalRuntimeStatus,
  ) => void;
  setLocalModelsFlagEnabled: (enabled: boolean) => void;

  // MCP Server Actions (Connectors)
  addMcpServer: (server: McpServerConfig) => void;
  updateMcpServer: (id: string, updates: Partial<McpServerConfig>) => void;
  deleteMcpServer: (id: string) => void;
  setAllowArbitraryMcpServers: (enabled: boolean) => void;
  setMcpArbitraryFlagEnabled: (enabled: boolean) => void;
  /** Replaces any existing rule for the same tool/server scope. */
  addToolApprovalRule: (
    rule: Omit<ToolApprovalRule, 'id' | 'createdAt'>,
  ) => void;
  removeToolApprovalRule: (id: string) => void;
  /**
   * Sets ONE tool's effective policy for ONE server: clears every rule that
   * currently applies to that tool on that server (scoped or unscoped —
   * otherwise a lingering unscoped block would silently override the new
   * choice), then stores a server-scoped rule; 'ask' stores nothing,
   * restoring the default prompt-every-time behavior.
   */
  setToolApprovalPolicy: (
    toolName: string,
    serverLabel: string,
    policy: 'approve' | 'reject' | 'ask',
  ) => void;

  // Context Window / Memories Actions
  setContextWindowSize: (size: number) => void;
  setMemoriesEnabled: (enabled: boolean) => void;
  setMemoriesFlagEnabled: (enabled: boolean) => void;
  setMemoryCapturePaused: (paused: boolean) => void;

  // Saved Structure Actions
  setSavedStructures: (structures: SavedStructure[]) => void;
  addSavedStructure: (structure: SavedStructure) => void;
  updateSavedStructure: (id: string, updates: Partial<SavedStructure>) => void;
  deleteSavedStructure: (id: string) => void;

  // Hidden Model/Agent Actions
  hideModel: (id: string) => void;
  unhideModel: (id: string) => void;

  // Starred Model/Agent Actions
  starModel: (id: string) => void;
  unstarModel: (id: string) => void;

  // Token usage tracking (see tokenUsageStats)
  recordTokenUsage: (usage: TokenUsageMetadata) => void;
  resetTokenUsageStats: () => void;
  /**
   * Folds back-calculated historical buckets into estimatedUsageStats AND
   * stamps historicalUsageBackfilledAt in one atomic set — a re-invoked
   * effect (StrictMode) reads the marker and skips, so no double merge.
   */
  mergeEstimatedUsage: (entries: Record<string, TokenUsageBucket>) => void;
  /** Stamps the backfill marker when there was nothing to merge (or on failure). */
  markHistoricalBackfillDone: () => void;

  // Model list provenance / region (runtime-only)
  setModelListSource: (source: ModelListSource | null) => void;
  setUserRegion: (region: UserRegion | null) => void;

  // Model Ordering Actions
  setModelOrderMode: (mode: ModelOrderMode) => void;
  setCustomModelOrder: (order: string[]) => void;
  moveModelInOrder: (modelId: string, direction: 'up' | 'down') => void;
  incrementModelUsage: (modelId: string) => void;
  recordSuccessfulModelUsage: (modelId: string) => void;
  resetModelOrder: () => void;

  // Organization Actions
  setOrganizationPreference: (org: MSFOrganization | null) => void;

  // TTS Actions
  setTTSSettings: (settings: Partial<TTSSettings>) => void;
  setGlobalVoice: (voiceName: string) => void;
  setLanguageVoice: (languageCode: string, voiceName: string) => void;
  clearLanguageVoice: (languageCode: string) => void;

  // Reasoning Model Actions
  setReasoningEffort: (effort: ReasoningEffort | undefined) => void;
  setVerbosity: (verbosity: Verbosity | undefined) => void;

  // Slash Menu Usage Actions
  incrementSlashMenuUsage: (itemId: string) => void;

  // Chat input "+" dropdown tool actions
  togglePinnedTool: (toolId: string) => void;
  incrementToolUsage: (toolId: string) => void;
  /**
   * Records a tool activation for usage-based ordering. Only bumps the durable
   * count after CONSECUTIVE_USAGE_THRESHOLD consecutive uses of the same tool,
   * so the order doesn't jump around during experimentation.
   */
  recordSuccessfulToolUsage: (toolId: string) => void;
  /**
   * Moves a tool into / out of the "More" section. `isDefaultHidden` tells the
   * action whether the tool is hidden by default (camera, tone-with-no-tones,
   * extract-with-no-recipes) so it can toggle the right set.
   */
  toggleToolHidden: (toolId: string, isDefaultHidden: boolean) => void;

  // Active Files Settings
  autoPinActiveFiles: boolean;
  setAutoPinActiveFiles: (enabled: boolean) => void;
  /**
   * When ON (default): pinned images are re-injected into every turn's last
   * user message so vision models keep "seeing" them. Costs ~765 tokens per
   * pinned image per turn (IMAGE_TOKENS_HIGH_DETAIL estimate; actual cost is
   * dimension-dependent).
   *
   * When OFF: pinned images survive eviction and stay in the panel, but the
   * model only sees them on turns where the user re-attaches them.
   *
   * Anthropic models currently strip image content at the handler level —
   * see lib/services/chat/handlers/AnthropicHandler.ts. Re-injection is a
   * no-op there until the handler grows a real Anthropic message converter.
   */
  autoInjectPinnedImages: boolean;
  setAutoInjectPinnedImages: (enabled: boolean) => void;

  /**
   * When ON (default): pasting a bare link into the chat composer fetches
   * that page server-side and attaches its readable text, so the model can
   * actually read what was linked instead of only seeing the URL.
   *
   * When OFF: a pasted link stays plain text. The explicit "Attach a link"
   * action still works — this gates only the automatic behavior.
   */
  autoFetchPastedLinks: boolean;
  setAutoFetchPastedLinks: (enabled: boolean) => void;

  /**
   * Character count above which pasted text becomes an attachment instead of
   * composer content. A wall of pasted text is a document, not a sentence:
   * inlining it buries the actual question and makes the composer unusable.
   *
   * `0` disables the behavior entirely. Values in between are clamped to
   * `PASTE_ATTACHMENT_MIN_CHARS` on read and write, so a hand-edited
   * localStorage value can't make every two-word paste into a file.
   */
  pasteAsAttachmentChars: number;
  setPasteAsAttachmentChars: (chars: number) => void;

  /**
   * How persistently the floating emissions chip is shown. Defaults to
   * `always` so the migration is a no-op for existing users; `auto` fades it
   * out between updates, `hidden` removes it entirely.
   *
   * Per-user and local, deliberately separate from the tenant-wide
   * `showUsageImpact` LaunchDarkly flag: the flag decides whether the feature
   * exists at all, this decides how loud it is for one person.
   */
  emissionsChipVisibility: EmissionsChipVisibility;
  setEmissionsChipVisibility: (visibility: EmissionsChipVisibility) => void;

  /**
   * How long the chip stays up after an update in `auto` mode, in ms. Ignored
   * by the other two modes.
   */
  emissionsChipAutoHideMs: number;
  setEmissionsChipAutoHideMs: (ms: number) => void;

  /**
   * Pacing of the map workflow's time-lapse. Persisted rather than kept as
   * workspace view state: how fast is comfortable to read is a property of
   * the person watching, not of the map they happen to have open.
   */
  mapTimelapse: MapTimelapseSettings;
  setMapTimelapse: (settings: Partial<MapTimelapseSettings>) => void;

  // Stop-generation confirmation preferences
  confirmStopFromButton: boolean;
  confirmStopFromKeyboard: boolean;
  /** Drop accepted/rejected review edits from the queue automatically. */
  autoClearResolvedEdits: boolean;
  /**
   * Default state of the "Suggest changes" checkbox on the Document composer:
   * a revision comes back as reviewable suggestions instead of overwriting the
   * document. Per-run the user can still tick it either way.
   */
  suggestRevisions: boolean;
  /**
   * Cases where a revision is applied DIRECTLY even with suggestions on,
   * because suggesting would be unhelpful or misleading. All default on.
   */
  suggestRevisionsExceptions: {
    /** A single change so large that accepting it accepts the whole rewrite. */
    largeRewrites: boolean;
    /** Sections moved rather than edited; each half reads as nonsense. */
    structuralReorders: boolean;
  };
  /**
   * Fraction of the document (0–1) that ONE change must span before
   * `largeRewrites` treats the result as unreviewable.
   */
  suggestRevisionsLargeRewriteRatio: number;
  setConfirmStopFromButton: (enabled: boolean) => void;
  setConfirmStopFromKeyboard: (enabled: boolean) => void;
  setAutoClearResolvedEdits: (enabled: boolean) => void;
  setSuggestRevisions: (enabled: boolean) => void;
  setSuggestRevisionsException: (
    key: 'largeRewrites' | 'structuralReorders',
    enabled: boolean,
  ) => void;
  setSuggestRevisionsLargeRewriteRatio: (ratio: number) => void;

  /**
   * Per-user Microsoft 365 opt-in. M365 features (attach from OneDrive/
   * SharePoint, email import, save to OneDrive) stay hidden until the user
   * explicitly connects in Settings → Connections — nothing is enabled by
   * virtue of signing in (docs/M365_GRAPH_PERMISSIONS_REQUEST.md).
   */
  m365Connected: boolean;
  setM365Connected: (connected: boolean) => void;

  /**
   * Global user toggle for the builtin Microsoft 365 toolset (the connector
   * tray's virtual row). Default ON: connecting M365 is itself the opt-in,
   * this is the "off everywhere" switch. Persisted.
   */
  m365ToolsUserEnabled: boolean;
  setM365ToolsUserEnabled: (enabled: boolean) => void;
  /**
   * Shared mailbox SMTP addresses the user says they can read (fifth pass
   * tier 3). Graph cannot enumerate these; the user maintains the list in
   * Settings → Connections and mail tools only ever target addresses on
   * it. Persisted.
   */
  m365SharedMailboxes: string[];
  setM365SharedMailboxes: (mailboxes: string[]) => void;
  /**
   * Whether playbook suggestion chips may appear above the composer (sixth
   * pass, docs/M365_SIXTH_PASS_CROSS_SERVICE_WORKFLOWS.md). Default ON:
   * chips only render when a precondition already holds and each one is
   * dismissible, but proactive suggestions can read as pushy — this is the
   * per-user off switch. The menu entries are unaffected. Persisted.
   */
  m365PlaybookChipsEnabled: boolean;
  setM365PlaybookChipsEnabled: (enabled: boolean) => void;
  /**
   * Runtime-only mirror of the LaunchDarkly `m365Tools` gate, set by
   * AppInitializer so chatStore (vanilla, no hook access) can gate what
   * gets SENT (same pattern as mcpArbitraryFlagEnabled). Fail-closed:
   * defaults to false. NOT persisted.
   */
  m365ToolsFlagEnabled: boolean;
  setM365ToolsFlagEnabled: (enabled: boolean) => void;

  /**
   * Remembered "Save to OneDrive" folder. null = the default app folder
   * (Apps/AI Assistant). When skip-picker is on, saves go straight to the
   * remembered destination without showing the dialog.
   */
  m365SaveDestination: M365SaveDestination | null;
  m365SaveSkipPicker: boolean;
  setM365SaveDestination: (destination: M365SaveDestination | null) => void;
  setM365SaveSkipPicker: (skip: boolean) => void;

  /**
   * Last browsed location in the attach-from-OneDrive picker. null = open
   * at the OneDrive root. Written by the picker on navigation only (never
   * on search) and dropped fail-open when the folder no longer loads.
   */
  m365PickerLocation: M365PickerLocation | null;
  setM365PickerLocation: (location: M365PickerLocation | null) => void;

  // Reset
  resetSettings: () => void;
}

/**
 * Fraction of a document that must change before a revision counts as a
 * wholesale rewrite. Half is the point past which a suggestion queue stops
 * being a review and starts being "accept the whole thing".
 */
const DEFAULT_LARGE_REWRITE_RATIO = 0.5;

const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_CONTEXT_WINDOW_SIZE = VALIDATION_LIMITS.CLIENT_MAX_MESSAGES; // 80
// Clamp bounds: below ~20 messages chats lose too much context; the server's
// ChatBodySchema rejects more than VALIDATION_LIMITS.MAX_API_MESSAGES (200).
const CONTEXT_WINDOW_MIN = 20;
const CONTEXT_WINDOW_MAX = VALIDATION_LIMITS.MAX_API_MESSAGES;
const DEFAULT_SYSTEM_PROMPT = '';
const DEFAULT_DISPLAY_NAME_PREFERENCE: DisplayNamePreference = 'firstName';
const DEFAULT_CUSTOM_DISPLAY_NAME = '';

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      // Initial state
      temperature: DEFAULT_TEMPERATURE,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      defaultModelId: undefined,
      defaultSearchMode: SearchMode.INTELLIGENT, // Privacy-focused intelligent search by default
      webSearchOptions: DEFAULT_WEB_SEARCH_OPTIONS,
      defaultInterpreterMode: InterpreterMode.INTELLIGENT, // Code interpreter on by default (auto-routed)
      autoSwitchOnFailure: false,
      displayNamePreference: DEFAULT_DISPLAY_NAME_PREFERENCE,
      customDisplayName: DEFAULT_CUSTOM_DISPLAY_NAME,
      models: [],
      prompts: [],
      tones: [],
      customAgents: [],
      customAgentSources: [],
      customModelSources: [],
      localRuntimePorts: {},
      localRuntimeStatus: {},
      localModelsFlagEnabled: false,
      glossaries: [],
      customLanguages: [],
      documentSpecs: [],
      documentCriteria: [],
      translationCriteria: [],
      mcpServers: [],
      toolApprovalRules: [],
      allowArbitraryMcpServers: false,
      mcpArbitraryFlagEnabled: false,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      memoriesEnabled: false,
      memoriesFlagEnabled: false,
      memoryCapturePaused: false,
      hiddenModelIds: [],
      starredModelIds: [],
      tokenUsageStats: {},
      tokenUsageFirstTrackedAt: null,
      estimatedUsageStats: {},
      historicalUsageBackfilledAt: null,
      modelListSource: null,
      userRegion: null,
      savedStructures: [],
      streamingSpeed: DEFAULT_STREAMING_SPEED,
      includeUserInfoInPrompt: false, // Default off for privacy
      preferredName: '',
      userContext: '',

      // Model ordering initial state
      modelOrderMode: 'usage',
      customModelOrder: [],
      modelUsageStats: {},
      consecutiveModelUsage: { modelId: null, count: 0 },

      // Slash menu usage tracking
      slashMenuUsageCounts: {},

      // Chat input "+" dropdown tool personalization
      pinnedToolIds: [],
      toolUsageCounts: {},
      hiddenToolIds: [],
      revealedToolIds: [],
      consecutiveToolUsage: { toolId: null, count: 0 },

      // Organization preference (null = auto-detect from email)
      organizationPreference: null,

      // TTS settings
      ttsSettings: DEFAULT_TTS_SETTINGS,

      // Reasoning model settings (undefined = use model defaults)
      reasoningEffort: undefined,
      verbosity: undefined,

      // Active files settings
      autoPinActiveFiles: true, // Auto-pin uploaded files by default
      autoInjectPinnedImages: true, // Re-inject pinned images each turn by default

      // Fetch pasted links and attach their text by default
      autoFetchPastedLinks: true,

      // Pasting more than this many characters attaches instead of inlining
      pasteAsAttachmentChars: DEFAULT_PASTE_ATTACHMENT_CHARS,

      // Emissions chip shown persistently by default
      emissionsChipVisibility: EMISSIONS_CHIP_VISIBILITY_DEFAULT,
      emissionsChipAutoHideMs: EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS,

      mapTimelapse: DEFAULT_MAP_TIMELAPSE,

      // Stop-generation confirmation preferences (both default ON)
      confirmStopFromButton: true,
      confirmStopFromKeyboard: true,
      autoClearResolvedEdits: false,
      m365Connected: false,
      m365ToolsUserEnabled: true,
      m365SharedMailboxes: [],
      m365PlaybookChipsEnabled: true,
      m365ToolsFlagEnabled: false,
      m365SaveDestination: null,
      m365SaveSkipPicker: false,
      m365PickerLocation: null,
      suggestRevisions: true,
      suggestRevisionsExceptions: {
        largeRewrites: true,
        structuralReorders: false,
      },
      suggestRevisionsLargeRewriteRatio: DEFAULT_LARGE_REWRITE_RATIO,

      // Actions
      setTemperature: (temperature) => set({ temperature }),

      setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

      setDefaultModelId: (id) => set({ defaultModelId: id }),

      setDefaultSearchMode: (mode) => set({ defaultSearchMode: mode }),
      setWebSearchOptions: (options) =>
        set((state) => ({
          webSearchOptions: sanitizeWebSearchOptions({
            ...state.webSearchOptions,
            ...options,
          }),
        })),
      setDefaultInterpreterMode: (mode) =>
        set({ defaultInterpreterMode: mode }),

      setAutoSwitchOnFailure: (enabled) =>
        set({ autoSwitchOnFailure: enabled }),

      setDisplayNamePreference: (preference) =>
        set({ displayNamePreference: preference }),

      setCustomDisplayName: (name) => set({ customDisplayName: name }),

      setStreamingSpeed: (config) => set({ streamingSpeed: config }),

      setIncludeUserInfoInPrompt: (enabled) =>
        set({ includeUserInfoInPrompt: enabled }),

      setPreferredName: (name) => set({ preferredName: name }),

      setUserContext: (context) => set({ userContext: context }),

      setModels: (models) => set({ models }),

      setPrompts: (prompts) => set({ prompts }),

      addPrompt: (prompt) =>
        set((state) => ({
          prompts: [...state.prompts, prompt],
        })),

      updatePrompt: (id, updates) =>
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === id ? { ...p, ...updates } : p,
          ),
        })),

      deletePrompt: (id) =>
        set((state) => ({
          prompts: state.prompts.filter((p) => p.id !== id),
        })),

      // Tone Actions
      setTones: (tones) => set({ tones }),

      addTone: (tone) =>
        set((state) => ({
          tones: [...state.tones, tone],
        })),

      updateTone: (id, updates) =>
        set((state) => ({
          tones: state.tones.map((t) =>
            t.id === id ? { ...t, ...updates } : t,
          ),
        })),

      deleteTone: (id) =>
        set((state) => ({
          tones: state.tones.filter((t) => t.id !== id),
        })),

      // Document spec / custom criterion actions (document workflow)
      addDocumentSpec: (spec) =>
        set((state) => ({
          documentSpecs: [...state.documentSpecs, spec],
        })),

      updateDocumentSpec: (id, updates) =>
        set((state) => ({
          documentSpecs: state.documentSpecs.map((s) =>
            s.id === id
              ? { ...s, ...updates, updatedAt: new Date().toISOString() }
              : s,
          ),
        })),

      deleteDocumentSpec: (id) =>
        set((state) => ({
          documentSpecs: state.documentSpecs.filter((s) => s.id !== id),
        })),

      addDocumentCriterion: (criterion) =>
        set((state) => ({
          documentCriteria: [...state.documentCriteria, criterion],
        })),

      updateDocumentCriterion: (id, updates) =>
        set((state) => ({
          documentCriteria: state.documentCriteria.map((c) =>
            c.id === id
              ? { ...c, ...updates, updatedAt: new Date().toISOString() }
              : c,
          ),
        })),

      deleteDocumentCriterion: (id) =>
        set((state) => ({
          documentCriteria: state.documentCriteria.filter((c) => c.id !== id),
        })),

      // Custom criteria actions (translation workflow). Kept separate from
      // documentCriteria: the rubrics are domain-specific (MQM dimensions
      // vs document quality), so one shared list would put irrelevant
      // criteria in both pickers.
      addTranslationCriterion: (criterion) =>
        set((state) => ({
          translationCriteria: [...state.translationCriteria, criterion],
        })),

      updateTranslationCriterion: (id, updates) =>
        set((state) => ({
          translationCriteria: state.translationCriteria.map((c) =>
            c.id === id
              ? { ...c, ...updates, updatedAt: new Date().toISOString() }
              : c,
          ),
        })),

      deleteTranslationCriterion: (id) =>
        set((state) => ({
          translationCriteria: state.translationCriteria.filter(
            (c) => c.id !== id,
          ),
        })),

      // Custom language actions (translation workflow)
      addCustomLanguage: (language) =>
        set((state) => ({
          customLanguages: [...state.customLanguages, language],
        })),

      deleteCustomLanguage: (id) =>
        set((state) => ({
          customLanguages: state.customLanguages.filter((l) => l.id !== id),
        })),

      // Glossary Actions (translation workflow)
      addGlossary: (glossary) =>
        set((state) => ({
          glossaries: [...state.glossaries, glossary],
        })),

      updateGlossary: (id, updates) =>
        set((state) => ({
          glossaries: state.glossaries.map((g) =>
            g.id === id
              ? { ...g, ...updates, updatedAt: new Date().toISOString() }
              : g,
          ),
        })),

      deleteGlossary: (id) =>
        set((state) => ({
          glossaries: state.glossaries.filter((g) => g.id !== id),
        })),

      // Custom Agent Actions
      setCustomAgents: (agents) => set({ customAgents: agents }),

      addCustomAgent: (agent) =>
        set((state) => ({
          customAgents: [...state.customAgents, agent],
        })),

      updateCustomAgent: (id, updates) =>
        set((state) => ({
          customAgents: state.customAgents.map((a) =>
            a.id === id ? { ...a, ...updates } : a,
          ),
        })),

      deleteCustomAgent: (id) =>
        set((state) => ({
          customAgents: state.customAgents.filter((a) => a.id !== id),
        })),

      // Agent Source Actions
      addCustomAgentSource: (source) =>
        set((state) => ({
          customAgentSources: [...state.customAgentSources, source],
        })),

      updateCustomAgentSource: (source) =>
        set((state) => ({
          customAgentSources: state.customAgentSources.map((s) =>
            s.id === source.id ? source : s,
          ),
        })),

      deleteCustomAgentSource: (id) =>
        set((state) => ({
          customAgentSources: state.customAgentSources.filter(
            (s) => s.id !== id,
          ),
        })),

      // Model Source Actions (BYO Foundry accounts)
      addCustomModelSource: (source) =>
        set((state) => ({
          customModelSources: [...state.customModelSources, source],
        })),

      updateCustomModelSource: (source) =>
        set((state) => ({
          customModelSources: state.customModelSources.map((s) =>
            s.id === source.id ? source : s,
          ),
        })),

      deleteCustomModelSource: (id) =>
        set((state) => ({
          customModelSources: state.customModelSources.filter(
            (s) => s.id !== id,
          ),
        })),

      // Local Runtime Actions (Ollama / LM Studio / llama.cpp)
      setLocalRuntimePort: (runtime, port) =>
        set((state) => {
          const next = { ...state.localRuntimePorts };
          // Reject anything undialable at the write boundary too, not just on
          // rehydrate — this value decides where a request is sent.
          if (port === undefined || !isValidPort(port)) {
            delete next[runtime];
          } else {
            next[runtime] = port;
          }
          return { localRuntimePorts: next };
        }),

      setLocalRuntimeStatus: (runtime, status) =>
        set((state) => ({
          localRuntimeStatus: {
            ...state.localRuntimeStatus,
            [runtime]: status,
          },
        })),

      setLocalModelsFlagEnabled: (enabled) =>
        set({ localModelsFlagEnabled: enabled }),

      // MCP Server Actions (Connectors)
      addMcpServer: (server) =>
        set((state) => ({ mcpServers: [...state.mcpServers, server] })),

      updateMcpServer: (id, updates) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === id ? { ...s, ...updates } : s,
          ),
        })),

      deleteMcpServer: (id) =>
        set((state) => ({
          mcpServers: state.mcpServers.filter((s) => s.id !== id),
        })),

      setAllowArbitraryMcpServers: (enabled) =>
        set({ allowArbitraryMcpServers: enabled }),

      addToolApprovalRule: (rule) =>
        set((state) => ({
          toolApprovalRules: [
            // One rule per (tool, scope): re-adding flips the action instead
            // of accumulating contradictory rules the evaluator would then
            // have to referee beyond its reject-wins tiebreak.
            ...state.toolApprovalRules.filter(
              (existing) =>
                existing.toolName !== rule.toolName ||
                (existing.serverLabel ?? '').trim().toLowerCase() !==
                  (rule.serverLabel ?? '').trim().toLowerCase(),
            ),
            {
              ...rule,
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
            },
          ],
        })),

      removeToolApprovalRule: (id) =>
        set((state) => ({
          toolApprovalRules: state.toolApprovalRules.filter(
            (rule) => rule.id !== id,
          ),
        })),

      setToolApprovalPolicy: (toolName, serverLabel, policy) =>
        set((state) => {
          const label = serverLabel.trim().toLowerCase();
          const kept = state.toolApprovalRules.filter(
            (rule) =>
              rule.toolName !== toolName ||
              (!!rule.serverLabel &&
                rule.serverLabel.trim().toLowerCase() !== label),
          );
          return {
            toolApprovalRules:
              policy === 'ask'
                ? kept
                : [
                    ...kept,
                    {
                      toolName,
                      serverLabel,
                      action: policy,
                      id: crypto.randomUUID(),
                      createdAt: new Date().toISOString(),
                    },
                  ],
          };
        }),

      setMcpArbitraryFlagEnabled: (enabled) =>
        set({ mcpArbitraryFlagEnabled: enabled }),

      // Context Window / Memories Actions
      setContextWindowSize: (size) =>
        set({
          contextWindowSize: Math.min(
            Math.max(size, CONTEXT_WINDOW_MIN),
            CONTEXT_WINDOW_MAX,
          ),
        }),

      setMemoriesEnabled: (enabled) => set({ memoriesEnabled: enabled }),

      setMemoriesFlagEnabled: (enabled) =>
        set({ memoriesFlagEnabled: enabled }),

      setMemoryCapturePaused: (paused) => set({ memoryCapturePaused: paused }),

      // Hidden Model/Agent Actions. Hiding unstars: a model can't be both
      // surfaced in "Your models" and hidden from the picker.
      hideModel: (id) =>
        set((state) =>
          state.hiddenModelIds.includes(id)
            ? state
            : {
                hiddenModelIds: [...state.hiddenModelIds, id],
                starredModelIds: state.starredModelIds.filter((m) => m !== id),
              },
        ),

      unhideModel: (id) =>
        set((state) => ({
          hiddenModelIds: state.hiddenModelIds.filter((m) => m !== id),
        })),

      // Starred Model/Agent Actions. Starring unhides (see hideModel).
      starModel: (id) =>
        set((state) =>
          state.starredModelIds.includes(id)
            ? state
            : {
                starredModelIds: [...state.starredModelIds, id],
                hiddenModelIds: state.hiddenModelIds.filter((m) => m !== id),
              },
        ),

      unstarModel: (id) =>
        set((state) => ({
          starredModelIds: state.starredModelIds.filter((m) => m !== id),
        })),

      setModelListSource: (source) => set({ modelListSource: source }),
      setUserRegion: (region) => set({ userRegion: region }),

      recordTokenUsage: (usage) =>
        set((state) => {
          const key = tokenUsageKey(usage);
          const bucket = state.tokenUsageStats[key];
          return {
            tokenUsageStats: {
              ...state.tokenUsageStats,
              [key]: {
                promptTokens: (bucket?.promptTokens ?? 0) + usage.promptTokens,
                completionTokens:
                  (bucket?.completionTokens ?? 0) + usage.completionTokens,
                requests: (bucket?.requests ?? 0) + 1,
              },
            },
            tokenUsageFirstTrackedAt:
              state.tokenUsageFirstTrackedAt ?? new Date().toISOString(),
          };
        }),

      resetTokenUsageStats: () =>
        set({
          tokenUsageStats: {},
          tokenUsageFirstTrackedAt: null,
          estimatedUsageStats: {},
          // Stamp (not null) so the one-time backfill doesn't resurrect the
          // history the user just chose to clear.
          historicalUsageBackfilledAt: new Date().toISOString(),
        }),

      mergeEstimatedUsage: (entries) =>
        set((state) => {
          const merged = { ...state.estimatedUsageStats };
          for (const [key, bucket] of Object.entries(entries)) {
            const existing = merged[key];
            merged[key] = {
              promptTokens: (existing?.promptTokens ?? 0) + bucket.promptTokens,
              completionTokens:
                (existing?.completionTokens ?? 0) + bucket.completionTokens,
              requests: (existing?.requests ?? 0) + bucket.requests,
            };
          }
          return {
            estimatedUsageStats: merged,
            historicalUsageBackfilledAt:
              state.historicalUsageBackfilledAt ?? new Date().toISOString(),
          };
        }),

      markHistoricalBackfillDone: () =>
        set((state) => ({
          historicalUsageBackfilledAt:
            state.historicalUsageBackfilledAt ?? new Date().toISOString(),
        })),

      // Saved Structure Actions
      setSavedStructures: (structures) => set({ savedStructures: structures }),

      addSavedStructure: (structure) =>
        set((state) => ({
          savedStructures: [...state.savedStructures, structure],
        })),

      updateSavedStructure: (id, updates) =>
        set((state) => ({
          savedStructures: state.savedStructures.map((s) =>
            s.id === id ? { ...s, ...updates } : s,
          ),
        })),

      deleteSavedStructure: (id) =>
        set((state) => ({
          savedStructures: state.savedStructures.filter((s) => s.id !== id),
        })),

      // Model Ordering Actions
      setModelOrderMode: (mode) => set({ modelOrderMode: mode }),

      setCustomModelOrder: (order) => set({ customModelOrder: order }),

      moveModelInOrder: (modelId, direction) =>
        set((state) => {
          // Initialize from default order if empty
          const order =
            state.customModelOrder.length > 0
              ? [...state.customModelOrder]
              : [...DEFAULT_MODEL_ORDER];

          const index = order.indexOf(modelId);
          if (index === -1) return state;

          const newIndex = direction === 'up' ? index - 1 : index + 1;
          if (newIndex < 0 || newIndex >= order.length) return state;

          // Swap the elements
          [order[index], order[newIndex]] = [order[newIndex], order[index]];

          return {
            customModelOrder: order,
            modelOrderMode: 'custom' as ModelOrderMode,
          };
        }),

      incrementModelUsage: (modelId) =>
        set((state) => ({
          modelUsageStats: {
            ...state.modelUsageStats,
            [modelId]: (state.modelUsageStats[modelId] ?? 0) + 1,
          },
        })),

      recordSuccessfulModelUsage: (modelId) =>
        set((state) => {
          const { consecutiveModelUsage, modelUsageStats } = state;
          const isSameModel = consecutiveModelUsage.modelId === modelId;
          const newCount = isSameModel ? consecutiveModelUsage.count + 1 : 1;
          const threshold =
            SETTINGS_CONSTANTS.MODEL_ORDER.CONSECUTIVE_USAGE_THRESHOLD;

          // Check if we've reached the threshold
          if (newCount >= threshold) {
            // Increment usage stats and reset consecutive counter
            return {
              modelUsageStats: {
                ...modelUsageStats,
                [modelId]: (modelUsageStats[modelId] ?? 0) + 1,
              },
              consecutiveModelUsage: { modelId, count: 0 },
            };
          }

          // Just update the consecutive counter
          return {
            consecutiveModelUsage: { modelId, count: newCount },
          };
        }),

      resetModelOrder: () =>
        set({
          modelOrderMode: 'usage' as ModelOrderMode,
          customModelOrder: [],
        }),

      // Organization Actions
      setOrganizationPreference: (org) => set({ organizationPreference: org }),

      // TTS Actions
      setTTSSettings: (settings) =>
        set((state) => ({
          ttsSettings: { ...state.ttsSettings, ...settings },
        })),

      setGlobalVoice: (voiceName) =>
        set((state) => ({
          ttsSettings: { ...state.ttsSettings, globalVoice: voiceName },
        })),

      setLanguageVoice: (languageCode, voiceName) =>
        set((state) => ({
          ttsSettings: {
            ...state.ttsSettings,
            languageVoices: {
              ...state.ttsSettings.languageVoices,
              [languageCode.toLowerCase()]: voiceName,
            },
          },
        })),

      clearLanguageVoice: (languageCode) =>
        set((state) => {
          const newLanguageVoices = { ...state.ttsSettings.languageVoices };
          delete newLanguageVoices[languageCode.toLowerCase()];
          return {
            ttsSettings: {
              ...state.ttsSettings,
              languageVoices: newLanguageVoices,
            },
          };
        }),

      // Reasoning Model Actions
      setReasoningEffort: (effort) => set({ reasoningEffort: effort }),
      setVerbosity: (verbosity) => set({ verbosity }),

      // Slash Menu Usage Actions
      incrementSlashMenuUsage: (itemId) =>
        set((state) => ({
          slashMenuUsageCounts: {
            ...state.slashMenuUsageCounts,
            [itemId]: (state.slashMenuUsageCounts[itemId] ?? 0) + 1,
          },
        })),

      // Chat input "+" dropdown tool actions
      togglePinnedTool: (toolId) =>
        set((state) => {
          const isPinned = state.pinnedToolIds.includes(toolId);
          if (isPinned) {
            return {
              pinnedToolIds: state.pinnedToolIds.filter((id) => id !== toolId),
            };
          }
          // Pinning wins over hiding — a pinned tool always shows in "Pinned",
          // so drop any explicit hide when pinning.
          return {
            pinnedToolIds: [...state.pinnedToolIds, toolId],
            hiddenToolIds: state.hiddenToolIds.filter((id) => id !== toolId),
          };
        }),
      incrementToolUsage: (toolId) =>
        set((state) => ({
          toolUsageCounts: {
            ...state.toolUsageCounts,
            [toolId]: (state.toolUsageCounts[toolId] ?? 0) + 1,
          },
        })),

      recordSuccessfulToolUsage: (toolId) =>
        set((state) => {
          const { consecutiveToolUsage, toolUsageCounts } = state;
          const isSameTool = consecutiveToolUsage.toolId === toolId;
          const newCount = isSameTool ? consecutiveToolUsage.count + 1 : 1;
          const threshold =
            SETTINGS_CONSTANTS.TOOL_ORDER.CONSECUTIVE_USAGE_THRESHOLD;

          if (newCount >= threshold) {
            // Credit the durable count and reset the consecutive counter.
            return {
              toolUsageCounts: {
                ...toolUsageCounts,
                [toolId]: (toolUsageCounts[toolId] ?? 0) + 1,
              },
              consecutiveToolUsage: { toolId, count: 0 },
            };
          }

          return {
            consecutiveToolUsage: { toolId, count: newCount },
          };
        }),

      toggleToolHidden: (toolId, isDefaultHidden) =>
        set((state) => {
          const isHidden =
            state.hiddenToolIds.includes(toolId) ||
            (isDefaultHidden && !state.revealedToolIds.includes(toolId));

          if (isHidden) {
            // Reveal: drop an explicit hide, and record the reveal so a
            // default-hidden tool stays out of "More".
            return {
              hiddenToolIds: state.hiddenToolIds.filter((id) => id !== toolId),
              revealedToolIds: isDefaultHidden
                ? [...new Set([...state.revealedToolIds, toolId])]
                : state.revealedToolIds,
            };
          }

          // Hide: drop any prior reveal; for non-default tools add an explicit
          // hide. Hiding also unpins so pin and hidden stay exclusive.
          return {
            revealedToolIds: state.revealedToolIds.filter(
              (id) => id !== toolId,
            ),
            hiddenToolIds: isDefaultHidden
              ? state.hiddenToolIds
              : [...new Set([...state.hiddenToolIds, toolId])],
            pinnedToolIds: state.pinnedToolIds.filter((id) => id !== toolId),
          };
        }),

      // Active Files Actions
      setAutoPinActiveFiles: (enabled) => set({ autoPinActiveFiles: enabled }),
      setAutoInjectPinnedImages: (enabled) =>
        set({ autoInjectPinnedImages: enabled }),

      setAutoFetchPastedLinks: (enabled) =>
        set({ autoFetchPastedLinks: enabled }),

      // Clamped on write as well as on read, for the same reason as the
      // timelapse sliders below: the UI is bounded, but a hand-edited
      // localStorage value must not make every paste an attachment.
      setPasteAsAttachmentChars: (chars) =>
        set({ pasteAsAttachmentChars: clampPasteAttachmentChars(chars) }),

      setEmissionsChipVisibility: (visibility) =>
        set({ emissionsChipVisibility: visibility }),

      // Clamped on write for the same reason as the paste threshold above.
      setEmissionsChipAutoHideMs: (ms) =>
        set({ emissionsChipAutoHideMs: clampEmissionsChipAutoHideMs(ms) }),

      // Clamped on write as well as on read: the sliders are bounded, but a
      // hand-edited localStorage value must not produce a frozen sweep.
      setMapTimelapse: (settings) =>
        set((state) => ({
          mapTimelapse: clampTimelapseSettings({
            ...state.mapTimelapse,
            ...settings,
          }),
        })),

      // Stop-generation confirmation actions
      setConfirmStopFromButton: (enabled) =>
        set({ confirmStopFromButton: enabled }),
      setConfirmStopFromKeyboard: (enabled) =>
        set({ confirmStopFromKeyboard: enabled }),

      setAutoClearResolvedEdits: (enabled) =>
        set({ autoClearResolvedEdits: enabled }),

      setSuggestRevisions: (enabled) => set({ suggestRevisions: enabled }),
      setM365Connected: (connected) =>
        set(
          connected
            ? { m365Connected: true }
            : {
                // Disconnecting drops the remembered save folder too — a stale
                // drive id must not leak into the next connection. Shared
                // mailboxes go with it: the list is meaningless without a
                // connected account.
                m365Connected: false,
                m365SaveDestination: null,
                m365SaveSkipPicker: false,
                m365PickerLocation: null,
                m365SharedMailboxes: [],
              },
        ),

      setM365ToolsUserEnabled: (enabled) =>
        set({ m365ToolsUserEnabled: enabled }),
      setM365SharedMailboxes: (mailboxes) =>
        set({
          m365SharedMailboxes: mailboxes
            .map((mailbox) => mailbox.trim().toLowerCase())
            .filter((mailbox, index, all) =>
              mailbox.includes('@') ? all.indexOf(mailbox) === index : false,
            )
            .slice(0, 10),
        }),
      setM365PlaybookChipsEnabled: (enabled) =>
        set({ m365PlaybookChipsEnabled: enabled }),
      setM365ToolsFlagEnabled: (enabled) =>
        set({ m365ToolsFlagEnabled: enabled }),

      setM365SaveDestination: (destination) =>
        set({ m365SaveDestination: destination }),
      setM365SaveSkipPicker: (skip) => set({ m365SaveSkipPicker: skip }),
      setM365PickerLocation: (location) =>
        set({ m365PickerLocation: location }),

      setSuggestRevisionsException: (key, enabled) =>
        set((state) => ({
          suggestRevisionsExceptions: {
            ...state.suggestRevisionsExceptions,
            [key]: enabled,
          },
        })),

      setSuggestRevisionsLargeRewriteRatio: (ratio) =>
        set({
          // Clamped: a ratio outside this band would make the exception either
          // always or never fire, which reads as the feature being broken.
          suggestRevisionsLargeRewriteRatio: Math.min(
            0.95,
            Math.max(0.1, ratio),
          ),
        }),

      resetSettings: () =>
        set({
          temperature: DEFAULT_TEMPERATURE,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          defaultSearchMode: SearchMode.INTELLIGENT,
          webSearchOptions: DEFAULT_WEB_SEARCH_OPTIONS,
          defaultInterpreterMode: InterpreterMode.INTELLIGENT,
          displayNamePreference: DEFAULT_DISPLAY_NAME_PREFERENCE,
          customDisplayName: DEFAULT_CUSTOM_DISPLAY_NAME,
          prompts: [],
          tones: [],
          customAgents: [],
          glossaries: [],
          translationCriteria: [],
          // Wipes connector tokens too — Reset Settings clears everything,
          // and lingering secrets after a "reset" would be worse.
          mcpServers: [],
          toolApprovalRules: [],
          allowArbitraryMcpServers: false,
          contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
          memoriesEnabled: false,
          memoryCapturePaused: false,
          hiddenModelIds: [],
          starredModelIds: [],
          tokenUsageStats: {},
          tokenUsageFirstTrackedAt: null,
          estimatedUsageStats: {},
          historicalUsageBackfilledAt: null,
          savedStructures: [],
          streamingSpeed: DEFAULT_STREAMING_SPEED,
          includeUserInfoInPrompt: false,
          preferredName: '',
          userContext: '',
          modelOrderMode: 'usage' as ModelOrderMode,
          customModelOrder: [],
          modelUsageStats: {},
          consecutiveModelUsage: { modelId: null, count: 0 },
          organizationPreference: null,
          ttsSettings: DEFAULT_TTS_SETTINGS,
          reasoningEffort: undefined,
          verbosity: undefined,
          slashMenuUsageCounts: {},
          pinnedToolIds: [],
          toolUsageCounts: {},
          autoPinActiveFiles: true,
          autoInjectPinnedImages: true,
          autoFetchPastedLinks: true,
          pasteAsAttachmentChars: DEFAULT_PASTE_ATTACHMENT_CHARS,
          emissionsChipVisibility: EMISSIONS_CHIP_VISIBILITY_DEFAULT,
          emissionsChipAutoHideMs: EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS,
          mapTimelapse: DEFAULT_MAP_TIMELAPSE,
          confirmStopFromButton: true,
          confirmStopFromKeyboard: true,
          autoClearResolvedEdits: false,
          suggestRevisions: true,
          suggestRevisionsExceptions: {
            largeRewrites: true,
            structuralReorders: false,
          },
          suggestRevisionsLargeRewriteRatio: DEFAULT_LARGE_REWRITE_RATIO,
          m365Connected: false,
          m365SaveDestination: null,
          m365SaveSkipPicker: false,
          m365PickerLocation: null,
          m365PlaybookChipsEnabled: true,
        }),
    }),
    {
      name: 'settings-storage',
      version: 55, // Increment this when schema changes to trigger migrations
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        temperature: state.temperature,
        systemPrompt: state.systemPrompt,
        defaultModelId: state.defaultModelId,
        defaultSearchMode: state.defaultSearchMode,
        webSearchOptions: state.webSearchOptions,
        defaultInterpreterMode: state.defaultInterpreterMode,
        autoSwitchOnFailure: state.autoSwitchOnFailure,
        displayNamePreference: state.displayNamePreference,
        customDisplayName: state.customDisplayName,
        prompts: state.prompts,
        tones: state.tones,
        customAgents: state.customAgents,
        customAgentSources: state.customAgentSources,
        customModelSources: state.customModelSources,
        // Port overrides persist; localRuntimeStatus and localModelsFlagEnabled
        // deliberately do NOT — see their declarations for why.
        localRuntimePorts: state.localRuntimePorts,
        glossaries: state.glossaries,
        customLanguages: state.customLanguages,
        documentSpecs: state.documentSpecs,
        documentCriteria: state.documentCriteria,
        translationCriteria: state.translationCriteria,
        // NOTE: mcpArbitraryFlagEnabled and memoriesFlagEnabled are
        // deliberately NOT persisted — they mirror LaunchDarkly flags and
        // must re-derive each session (a persisted true would survive a
        // flag-off).
        //
        // SECRETS ARE REDACTED from the persisted blob: localStorage holds
        // NO MCP credentials (PATs, OAuth tokens, client secrets). They live
        // encrypted in the credential vault (client/services/mcp/
        // credentialVault.ts) and are merged back into the in-memory store
        // by mcpCredentialSync on authenticated boot. This write also
        // scrubs any legacy plaintext from pre-vault blobs.
        mcpServers: state.mcpServers.map((server) => ({
          ...server,
          authToken: undefined,
          oauth: server.oauth
            ? {
                ...server.oauth,
                accessToken: undefined,
                refreshToken: undefined,
                clientSecret: undefined,
              }
            : undefined,
          oauthApp: server.oauthApp
            ? { ...server.oauthApp, clientSecret: undefined }
            : undefined,
        })),
        allowArbitraryMcpServers: state.allowArbitraryMcpServers,
        toolApprovalRules: state.toolApprovalRules,
        contextWindowSize: state.contextWindowSize,
        memoriesEnabled: state.memoriesEnabled,
        memoryCapturePaused: state.memoryCapturePaused,
        hiddenModelIds: state.hiddenModelIds,
        starredModelIds: state.starredModelIds,
        tokenUsageStats: state.tokenUsageStats,
        tokenUsageFirstTrackedAt: state.tokenUsageFirstTrackedAt,
        estimatedUsageStats: state.estimatedUsageStats,
        historicalUsageBackfilledAt: state.historicalUsageBackfilledAt,
        savedStructures: state.savedStructures,
        streamingSpeed: state.streamingSpeed,
        includeUserInfoInPrompt: state.includeUserInfoInPrompt,
        preferredName: state.preferredName,
        userContext: state.userContext,
        modelOrderMode: state.modelOrderMode,
        customModelOrder: state.customModelOrder,
        modelUsageStats: state.modelUsageStats,
        consecutiveModelUsage: state.consecutiveModelUsage,
        organizationPreference: state.organizationPreference,
        ttsSettings: state.ttsSettings,
        reasoningEffort: state.reasoningEffort,
        verbosity: state.verbosity,
        slashMenuUsageCounts: state.slashMenuUsageCounts,
        pinnedToolIds: state.pinnedToolIds,
        toolUsageCounts: state.toolUsageCounts,
        hiddenToolIds: state.hiddenToolIds,
        revealedToolIds: state.revealedToolIds,
        consecutiveToolUsage: state.consecutiveToolUsage,
        autoPinActiveFiles: state.autoPinActiveFiles,
        autoInjectPinnedImages: state.autoInjectPinnedImages,
        autoFetchPastedLinks: state.autoFetchPastedLinks,
        pasteAsAttachmentChars: state.pasteAsAttachmentChars,
        emissionsChipVisibility: state.emissionsChipVisibility,
        emissionsChipAutoHideMs: state.emissionsChipAutoHideMs,
        mapTimelapse: state.mapTimelapse,
        confirmStopFromButton: state.confirmStopFromButton,
        confirmStopFromKeyboard: state.confirmStopFromKeyboard,
        autoClearResolvedEdits: state.autoClearResolvedEdits,
        suggestRevisions: state.suggestRevisions,
        m365Connected: state.m365Connected,
        // m365ToolsFlagEnabled is deliberately NOT persisted (LD mirror,
        // same rationale as mcpArbitraryFlagEnabled above).
        m365ToolsUserEnabled: state.m365ToolsUserEnabled,
        m365SharedMailboxes: state.m365SharedMailboxes,
        m365PlaybookChipsEnabled: state.m365PlaybookChipsEnabled,
        m365SaveDestination: state.m365SaveDestination,
        m365SaveSkipPicker: state.m365SaveSkipPicker,
        m365PickerLocation: state.m365PickerLocation,
        suggestRevisionsExceptions: state.suggestRevisionsExceptions,
        suggestRevisionsLargeRewriteRatio:
          state.suggestRevisionsLargeRewriteRatio,
      }),
      migrate: (persistedState, version) => {
        const state = persistedState as Record<string, unknown>;

        // Version 4 → 5: Convert 'default' mode to 'usage'
        if (version < 5 && state.modelOrderMode === 'default') {
          state.modelOrderMode = 'usage';
        }

        // Version 5 → 6: Add streamingSpeed with default values
        if (version < 6 && !state.streamingSpeed) {
          state.streamingSpeed = DEFAULT_STREAMING_SPEED;
        }

        // Version 6 → 7: Add organizationPreference (null = auto-detect)
        if (version < 7 && state.organizationPreference === undefined) {
          state.organizationPreference = null;
        }

        // Version 7 → 8: Add includeUserInfoInPrompt (default: false for privacy)
        if (version < 8 && state.includeUserInfoInPrompt === undefined) {
          state.includeUserInfoInPrompt = false;
        }

        // Version 8 → 9: Add preferredName and userContext
        if (version < 9) {
          if (state.preferredName === undefined) state.preferredName = '';
          if (state.userContext === undefined) state.userContext = '';
        }

        // Version 9 → 10: Add ttsSettings
        if (version < 10 && state.ttsSettings === undefined) {
          state.ttsSettings = DEFAULT_TTS_SETTINGS;
        }

        // Version 10 → 11: Migrate TTS settings from voiceName to globalVoice/languageVoices
        if (version < 11 && state.ttsSettings !== undefined) {
          const oldSettings = state.ttsSettings as Record<string, unknown>;

          // Check if using old format (has voiceName instead of globalVoice)
          if ('voiceName' in oldSettings && !('globalVoice' in oldSettings)) {
            const oldVoiceName = oldSettings.voiceName as string;
            const newSettings: TTSSettings = {
              globalVoice: oldVoiceName || DEFAULT_TTS_SETTINGS.globalVoice,
              languageVoices: {},
              rate: (oldSettings.rate as number) ?? DEFAULT_TTS_SETTINGS.rate,
              pitch:
                (oldSettings.pitch as number) ?? DEFAULT_TTS_SETTINGS.pitch,
              outputFormat:
                (oldSettings.outputFormat as TTSSettings['outputFormat']) ??
                DEFAULT_TTS_SETTINGS.outputFormat,
            };

            // If the old voice was language-specific, migrate it as that language's default
            if (oldVoiceName) {
              const localeMatch = oldVoiceName.match(/^([a-z]{2})-[A-Z]{2}/);
              if (localeMatch) {
                const baseLanguage = localeMatch[1].toLowerCase();
                newSettings.languageVoices[baseLanguage] = oldVoiceName;
              }
            }

            state.ttsSettings = newSettings;
          }
        }

        // Version 11 → 12: Add reasoning model settings (reasoningEffort, verbosity)
        if (version < 12) {
          if (state.reasoningEffort === undefined)
            state.reasoningEffort = undefined;
          if (state.verbosity === undefined) state.verbosity = undefined;
        }

        // Version 12 → 13: Add consecutiveModelUsage for stable model ordering
        if (version < 13) {
          if (state.consecutiveModelUsage === undefined) {
            state.consecutiveModelUsage = { modelId: null, count: 0 };
          }
        }

        // Version 13 → 14: Add autoPinActiveFiles setting
        if (version < 14) {
          if (state.autoPinActiveFiles === undefined) {
            state.autoPinActiveFiles = true;
          }
        }

        // Version 14 → 15: Add slashMenuUsageCounts
        if (version < 15) {
          if (state.slashMenuUsageCounts === undefined) {
            state.slashMenuUsageCounts = {};
          }
        }

        // Version 15 → 16: Add stop-generation confirmation preferences
        if (version < 16) {
          if (state.confirmStopFromButton === undefined) {
            state.confirmStopFromButton = true;
          }
          if (state.confirmStopFromKeyboard === undefined) {
            state.confirmStopFromKeyboard = true;
          }
        }

        // Version 16 → 17: Add autoInjectPinnedImages (default ON to preserve
        // current "pinned images stay visible to vision models" intuition)
        if (version < 17) {
          if (state.autoInjectPinnedImages === undefined) {
            state.autoInjectPinnedImages = true;
          }
        }

        // Version 17 → 18: Add customAgentSources (custom Foundry projects the
        // user has connected for agent discovery). The field was introduced
        // without a version bump; without this, pre-existing stores rehydrate
        // it as undefined and any `.map`/`.find` over it would throw.
        if (version < 18) {
          if (!Array.isArray(state.customAgentSources)) {
            state.customAgentSources = [];
          }
        }

        // Version 18 → 19: Add hiddenModelIds (per-user list of models/agents
        // hidden from the picker). Backfill to [] so downstream filtering never
        // operates on undefined.
        if (version < 19) {
          if (!Array.isArray(state.hiddenModelIds)) {
            state.hiddenModelIds = [];
          }
        }

        // Version 19 → 20: Add starredModelIds (models surfaced in the
        // picker's Favorites section). Backfill to [].
        if (version < 20) {
          if (!Array.isArray(state.starredModelIds)) {
            state.starredModelIds = [];
          }
        }

        // Version 20 → 21: Add token usage tracking. Backfill empty.
        if (version < 21) {
          if (
            state.tokenUsageStats === undefined ||
            state.tokenUsageStats === null ||
            typeof state.tokenUsageStats !== 'object'
          ) {
            state.tokenUsageStats = {};
          }
          if (state.tokenUsageFirstTrackedAt === undefined) {
            state.tokenUsageFirstTrackedAt = null;
          }
        }

        // Version 21 → 22: Add MCP connectors (Connectors settings section).
        // Backfill empty list / opt-in off.
        if (version < 22) {
          if (!Array.isArray(state.mcpServers)) {
            state.mcpServers = [];
          }
          if (typeof state.allowArbitraryMcpServers !== 'boolean') {
            state.allowArbitraryMcpServers = false;
          }
        }

        // Version 22 → 23: Add per-server authMode + OAuth support. Servers
        // whose CATALOG auth style is 'oauth' (Asana) also get any stored PAT
        // cleared: a PAT saved under the old bearer assumption never worked
        // against an OAuth-only server, and a credential must not be relayed
        // under the wrong scheme. They render as disconnected ("Connect").
        if (version < 23 && Array.isArray(state.mcpServers)) {
          state.mcpServers = (
            state.mcpServers as Array<Record<string, unknown>>
          ).map((server) => {
            if (typeof server.authMode === 'string') return server;
            const catalogStyle = server.catalogKey
              ? MCP_CATALOG[server.catalogKey as string]?.auth.style
              : undefined;
            if (catalogStyle === 'oauth') {
              return {
                ...server,
                authMode: 'oauth',
                authToken: undefined,
                oauth: undefined,
              };
            }
            return {
              ...server,
              authMode: server.authToken ? 'bearer' : 'none',
            };
          });
        }

        // Version 23 → 24: Merge in structured-data-extraction (extractionRecipes)
        // and chat-input tool personalization (pinnedToolIds/toolUsageCounts).
        // Backfill all three so downstream `.map`/`.includes` never operate on
        // undefined for stores created before the feature branch merged.
        if (version < 24) {
          if (!Array.isArray(state.extractionRecipes)) {
            state.extractionRecipes = [];
          }
          if (!Array.isArray(state.pinnedToolIds)) {
            state.pinnedToolIds = [];
          }
          if (
            state.toolUsageCounts === undefined ||
            state.toolUsageCounts === null ||
            typeof state.toolUsageCounts !== 'object'
          ) {
            state.toolUsageCounts = {};
          }
        }

        // Version 24 → 25: add the "More" section personalization fields
        // (hiddenToolIds / revealedToolIds) and the usage-ordering debounce
        // counter. Backfill so downstream `.includes` / reads never hit
        // undefined for stores created before this change.
        if (version < 25) {
          if (!Array.isArray(state.hiddenToolIds)) {
            state.hiddenToolIds = [];
          }
          if (!Array.isArray(state.revealedToolIds)) {
            state.revealedToolIds = [];
          }
          if (
            state.consecutiveToolUsage === undefined ||
            state.consecutiveToolUsage === null ||
            typeof state.consecutiveToolUsage !== 'object'
          ) {
            state.consecutiveToolUsage = { toolId: null, count: 0 };
          }
        }

        // Version 25 → 26: translation-workflow glossaries collection
        if (version < 26 && !Array.isArray(state.glossaries)) {
          state.glossaries = [];
        }

        // Version 26 → 27: user-added translation target languages
        if (version < 27 && !Array.isArray(state.customLanguages)) {
          state.customLanguages = [];
        }

        // Version 27 → 28: document specs + custom quality criteria
        if (version < 28) {
          if (!Array.isArray(state.documentSpecs)) state.documentSpecs = [];
          if (!Array.isArray(state.documentCriteria)) {
            state.documentCriteria = [];
          }
        }

        // Version 28 → 29: per-source agent selection. Defaults reproduce the
        // pre-selection behavior exactly (auto-add everything, exclude none).
        if (version < 29 && Array.isArray(state.customAgentSources)) {
          state.customAgentSources = (
            state.customAgentSources as Array<Record<string, unknown>>
          ).map((source) => ({
            ...source,
            autoAddNewAgents:
              typeof source.autoAddNewAgents === 'boolean'
                ? source.autoAddNewAgents
                : true,
            excludedAgentNames: Array.isArray(source.excludedAgentNames)
              ? source.excludedAgentNames
              : [],
            selectedAgentNames: Array.isArray(source.selectedAgentNames)
              ? source.selectedAgentNames
              : [],
          }));
        }

        // Version 29 → 30: Add customModelSources (BYO Foundry accounts the
        // user connected for model discovery). Backfill to [] so downstream
        // `.map`/`.find` never operate on undefined.
        if (version < 30) {
          if (!Array.isArray(state.customModelSources)) {
            state.customModelSources = [];
          }
        }

        // Version 30 → 31: Back-calculated (estimated) usage buckets + the
        // one-time historical-backfill marker. Backfill empty/null; the
        // AppInitializer effect runs the actual back-calculation.
        if (version < 31) {
          if (
            state.estimatedUsageStats == null ||
            typeof state.estimatedUsageStats !== 'object'
          ) {
            state.estimatedUsageStats = {};
          }
          if (state.historicalUsageBackfilledAt === undefined) {
            state.historicalUsageBackfilledAt = null;
          }
        }

        // Version 31 → 33: Estimated buckets are derived data; wipe and
        // re-arm the one-shot backfill whenever its math is corrected so
        // stats rebuild cleanly. v32: the v31 backfill wrongly skipped
        // conversations whose model carries isAgent:true (a "web-search
        // agent available" marker on ordinary base models — not an agent
        // chat). v33: back-calc now windows context like the real pipeline
        // (first + last 79 messages, capped at model context) instead of
        // growing quadratically on long conversations.
        if (version < 33) {
          state.estimatedUsageStats = {};
          state.historicalUsageBackfilledAt = null;
        }

        // Version 33 → 34: Adjustable context window (conversation
        // compaction) + Memories opt-in. Backfill to the previous hard-coded
        // window size and feature-off so behavior is unchanged until the
        // user opts in.
        if (version < 34) {
          if (state.contextWindowSize === undefined) {
            state.contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE;
          }
          if (state.memoriesEnabled === undefined) {
            state.memoriesEnabled = false;
          }
        }

        // Version 34 → 35: Local model runtime port overrides. Backfill to {}
        // so downstream lookups never index undefined; every runtime falls
        // back to its default port until the user changes one.
        if (version < 35) {
          if (
            state.localRuntimePorts === null ||
            typeof state.localRuntimePorts !== 'object'
          ) {
            state.localRuntimePorts = {};
          }
        }

        // Version 35 → 36: Add autoFetchPastedLinks (default ON — pasting a
        // link and having its content read is the useful behavior; the
        // toggle exists for users who would rather links stay inert).
        if (version < 36) {
          if (state.autoFetchPastedLinks === undefined) {
            state.autoFetchPastedLinks = true;
          }
        }

        // Version 36 → 37: Add mapTimelapse pacing. Clamped rather than
        // replaced, so a partially-written value keeps whatever half of it
        // was valid.
        if (version < 37) {
          state.mapTimelapse = clampTimelapseSettings(
            state.mapTimelapse as Partial<MapTimelapseSettings> | undefined,
          );
        }

        // Version 37 → 38: Add the auto-clear-resolved-edits preference.
        // Defaults off so the decision record stays visible until asked
        // otherwise.
        if (version < 38) {
          if (state.autoClearResolvedEdits === undefined) {
            state.autoClearResolvedEdits = false;
          }
        }

        // Version 38 → 39: custom quality criteria for the translation
        // workflow, mirroring documentCriteria (v28).
        if (version < 39) {
          if (!Array.isArray(state.translationCriteria)) {
            state.translationCriteria = [];
          }
        }

        // Version 39 → 40: Add pasteAsAttachmentChars. Clamped rather than
        // defaulted so an out-of-range hand-edited value keeps its intent
        // (a very large threshold still means "rarely attach") instead of
        // silently snapping back to the default.
        if (version < 40) {
          state.pasteAsAttachmentChars = clampPasteAttachmentChars(
            state.pasteAsAttachmentChars,
          );
        }

        // Version 40 → 41: extractionRecipes → savedStructures. The
        // collection is now shared with the data workflow, so `required`
        // adopts the tabular polarity: absent = OPTIONAL. Recipes meant the
        // opposite (absent = required, see the old recipeToJsonSchema), so
        // every legacy field that omitted the flag is stamped `true` here.
        // Without this, every saved recipe would silently loosen and start
        // emitting nullable unions for fields the user marked required.
        if (version < 41) {
          const legacy = Array.isArray(state.extractionRecipes)
            ? (state.extractionRecipes as Record<string, unknown>[])
            : [];
          state.savedStructures = legacy.map((recipe) => ({
            ...recipe,
            fields: (Array.isArray(recipe.fields)
              ? (recipe.fields as Record<string, unknown>[])
              : []
            ).map((field) => ({
              ...field,
              required: field.required !== false,
            })),
          }));
          delete state.extractionRecipes;
        }

        // Version 41 → 42: Suggested revisions. Defaults ON — a requested
        // revision comes back reviewable rather than overwriting the document
        // — with all three bypasses on, matching the shipped defaults.
        if (version < 42) {
          if (state.suggestRevisions === undefined) {
            state.suggestRevisions = true;
          }
          const exceptions = state.suggestRevisionsExceptions as
            | Record<string, unknown>
            | undefined;
          state.suggestRevisionsExceptions = {
            largeRewrites: exceptions?.largeRewrites !== false,
            structuralReorders: exceptions?.structuralReorders !== false,
          };
          if (typeof state.suggestRevisionsLargeRewriteRatio !== 'number') {
            state.suggestRevisionsLargeRewriteRatio =
              DEFAULT_LARGE_REWRITE_RATIO;
          }
        }

        // Version 42 → 43: the v42 exceptions were far too eager — in practice
        // a requested revision was almost always applied instead of suggested,
        // which is the opposite of what the feature is for. The threshold now
        // measures the LARGEST SINGLE change rather than total change, reorder
        // detection is off by default (a moved block still reviews fine), and
        // `selectionScoped` is gone: it is now unconditional, because a
        // selection revise returns an excerpt that cannot be diffed against
        // the document at all. Reset rather than preserved — these were our
        // broken defaults, not a considered user choice.
        if (version < 43) {
          state.suggestRevisionsExceptions = {
            largeRewrites: true,
            structuralReorders: false,
          };
          state.suggestRevisionsLargeRewriteRatio = DEFAULT_LARGE_REWRITE_RATIO;
        }

        // Version 43 → 44: Add per-user emissions chip visibility. Defaults to
        // `always`, i.e. the behavior these users already have — the setting
        // exists to let them turn it down, not to change anything for them.
        // Both fields are validated rather than trusted: they round-trip
        // through localStorage where a stale or hand-edited value would
        // otherwise reach the render path.
        if (version < 44) {
          if (!isEmissionsChipVisibility(state.emissionsChipVisibility)) {
            state.emissionsChipVisibility = EMISSIONS_CHIP_VISIBILITY_DEFAULT;
          }
          state.emissionsChipAutoHideMs = clampEmissionsChipAutoHideMs(
            state.emissionsChipAutoHideMs as number,
          );
        }

        // Version 44 → 45: Add global MCP tool approval rules.
        if (version < 45) {
          if (!Array.isArray(state.toolApprovalRules)) {
            state.toolApprovalRules = [];
          }
        }

        // Version 45 → 46: Add default code-interpreter mode (on by default).
        if (version < 46) {
          if (!isInterpreterMode(state.defaultInterpreterMode)) {
            state.defaultInterpreterMode = InterpreterMode.INTELLIGENT;
          }
        }

        // Version 46 → 47: Add advanced web-search options (sanitize repairs
        // both absent and malformed persisted values).
        // Version 47 → 48: Add the search provider option (same repair).
        if (version < 48) {
          state.webSearchOptions = sanitizeWebSearchOptions(
            state.webSearchOptions,
          );
        }

        // Version 48 → 49: Pause-capture toggle for Memories. Backfill to
        // not-paused so an existing opt-in keeps capturing as it did.
        if (version < 49) {
          if (typeof state.memoryCapturePaused !== 'boolean') {
            state.memoryCapturePaused = false;
          }
        }

        // Version 49 → 50: Microsoft 365 opt-in. Backfill to disconnected —
        // M365 access is explicit per-user opt-in, never a default.
        if (version < 50) {
          if (typeof state.m365Connected !== 'boolean') {
            state.m365Connected = false;
          }
        }

        // Version 50 → 51: Remembered "Save to OneDrive" destination.
        // Backfill to the defaults (default app folder, dialog shown) —
        // matching the behavior these users already have.
        if (version < 51) {
          if (state.m365SaveDestination === undefined) {
            state.m365SaveDestination = null;
          }
          if (typeof state.m365SaveSkipPicker !== 'boolean') {
            state.m365SaveSkipPicker = false;
          }
        }

        // Version 51 → 52: Global toggle for the builtin M365 toolset.
        // Backfill to ON — connecting M365 is the opt-in; this is only the
        // "off everywhere" switch, and the LD flag still gates everything.
        if (version < 52) {
          if (typeof state.m365ToolsUserEnabled !== 'boolean') {
            state.m365ToolsUserEnabled = true;
          }
        }

        // Version 52 → 53: shared mailbox address list (fifth pass tier 3).
        if (version < 53) {
          if (!Array.isArray(state.m365SharedMailboxes)) {
            state.m365SharedMailboxes = [];
          }
        }

        // Version 53 → 54: playbook suggestion chips (sixth pass). Backfill
        // to ON — the chips are precondition-gated and dismissible, and the
        // LD flag still gates the whole feature.
        if (version < 54) {
          if (typeof state.m365PlaybookChipsEnabled !== 'boolean') {
            state.m365PlaybookChipsEnabled = true;
          }
        }

        // Version 54 → 55: remembered attach-picker location. Backfill to
        // null — open at the OneDrive root, as these users always have.
        if (version < 55) {
          if (state.m365PickerLocation === undefined) {
            state.m365PickerLocation = null;
          }
        }

        return state;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Validate defaultModelId still exists - if not, reset it
          if (
            state.defaultModelId &&
            !OpenAIModels[state.defaultModelId as OpenAIModelID]
          ) {
            console.warn(
              `[SettingsStore] Default model "${state.defaultModelId}" no longer exists, resetting to undefined`,
            );
            state.defaultModelId = undefined;
          }

          // Clean up defunct model IDs from customModelOrder
          if (state.customModelOrder && state.customModelOrder.length > 0) {
            const validModelIds = state.customModelOrder.filter(
              (id) => OpenAIModels[id as OpenAIModelID],
            );
            if (validModelIds.length !== state.customModelOrder.length) {
              console.warn(
                `[SettingsStore] Removed ${state.customModelOrder.length - validModelIds.length} defunct model IDs from custom order`,
              );
              state.customModelOrder = validModelIds;
            }
          }

          // Defensive: customAgentSources must always be an array. Guards
          // against a store persisted at v18+ that somehow lacks the field
          // (e.g. a partial write) so downstream `.map`/`.find` never throw.
          if (!Array.isArray(state.customAgentSources)) {
            state.customAgentSources = [];
          } else {
            // Per-element selection fields must be well-formed too — a partial
            // write missing them must behave as "auto-add all", never hide
            // agents or crash the filter.
            state.customAgentSources = state.customAgentSources.map(
              (source) => ({
                ...source,
                autoAddNewAgents:
                  typeof source.autoAddNewAgents === 'boolean'
                    ? source.autoAddNewAgents
                    : true,
                excludedAgentNames: Array.isArray(source.excludedAgentNames)
                  ? source.excludedAgentNames
                  : [],
                selectedAgentNames: Array.isArray(source.selectedAgentNames)
                  ? source.selectedAgentNames
                  : [],
              }),
            );
          }

          // Defensive: customModelSources must always be an array (same
          // rationale as customAgentSources above).
          if (!Array.isArray(state.customModelSources)) {
            state.customModelSources = [];
          } else {
            // Per-element selection fields must be well-formed too — a partial
            // write missing them must behave as "auto-add all", never hide
            // models or crash the filter.
            state.customModelSources = state.customModelSources.map(
              (source) => ({
                ...source,
                autoAddNewModels:
                  typeof source.autoAddNewModels === 'boolean'
                    ? source.autoAddNewModels
                    : true,
                excludedModelNames: Array.isArray(source.excludedModelNames)
                  ? source.excludedModelNames
                  : [],
                selectedModelNames: Array.isArray(source.selectedModelNames)
                  ? source.selectedModelNames
                  : [],
              }),
            );
          }

          // Defensive: mcpServers must always be an array (same rationale).
          if (!Array.isArray(state.mcpServers)) {
            state.mcpServers = [];
          }

          // SECURITY: localRuntimePorts is the only persisted value that
          // steers where a local chat request is sent, so a tampered or
          // corrupt localStorage blob must not survive rehydration. Anything
          // that isn't an integer port in 1–65535 is dropped, falling the
          // runtime back to its built-in default. (The host is never
          // persisted — it is hard-coded to 127.0.0.1 — so this is the whole
          // attack surface.)
          if (
            state.localRuntimePorts === null ||
            typeof state.localRuntimePorts !== 'object' ||
            Array.isArray(state.localRuntimePorts)
          ) {
            state.localRuntimePorts = {};
          } else {
            const sanitized: Partial<Record<LocalRuntime, number>> = {};
            for (const runtime of LOCAL_RUNTIMES) {
              const port = state.localRuntimePorts[runtime];
              if (isValidPort(port)) sanitized[runtime] = port;
            }
            state.localRuntimePorts = sanitized;
          }

          // Detection results are session-scoped; never trust a rehydrated
          // one even if a future partialize change starts writing them.
          state.localRuntimeStatus = {};
          state.localModelsFlagEnabled = false;

          // Defensive: hiddenModelIds must always be an array. NOTE: do not
          // prune entries against OpenAIModels here — agent IDs (`org-*`,
          // `foundry-*`) are not keys in that registry, so validating against
          // it would wrongly drop hidden agents. Stale base-model IDs are
          // harmless (they simply never match anything).
          if (!Array.isArray(state.hiddenModelIds)) {
            state.hiddenModelIds = [];
          }

          // Defensive: starredModelIds — same rules as hiddenModelIds above
          // (always an array; never prune against OpenAIModels, starred ids
          // can be agents or currently-undiscovered models).
          if (!Array.isArray(state.starredModelIds)) {
            state.starredModelIds = [];
          }

          // Defensive: token usage stats must always be a plain object.
          if (
            state.tokenUsageStats == null ||
            typeof state.tokenUsageStats !== 'object'
          ) {
            state.tokenUsageStats = {};
          }

          // Defensive: estimated (back-calculated) usage — same rationale.
          if (
            state.estimatedUsageStats == null ||
            typeof state.estimatedUsageStats !== 'object'
          ) {
            state.estimatedUsageStats = {};
          }

          // Defensive: savedStructures must always be an array (same
          // rationale as mcpServers) so `.map`/`.filter` never throw.
          if (!Array.isArray(state.savedStructures)) {
            state.savedStructures = [];
          }
        }
      },
    },
  ),
);
