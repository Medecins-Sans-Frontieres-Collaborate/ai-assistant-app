'use client';

import { TokenUsageMetadata } from '@/lib/utils/app/metadata';
import { UserRegion } from '@/lib/utils/shared/region';

import { ExtractionRecipe } from '@/types/extractionRecipe';
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
import { Tone } from '@/types/tone';
import { DEFAULT_TTS_SETTINGS, TTSSettings } from '@/types/tts';
import {
  CustomTranslationLanguage,
  DocumentCustomCriterion,
  DocumentSpec,
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
export function tokenUsageKey(usage: TokenUsageMetadata): string {
  return `${usage.modelId}|${usage.region ?? 'default'}|${usage.reasoningEffort ?? 'none'}`;
}

/** A Foundry project endpoint that the app discovers agents from */
export interface AgentSource {
  id: string;
  name: string; // User-friendly label: "Amsterdam Office", "Geneva Hub"
  resourcePath: string; // ARM resource path to Foundry project
  createdAt: string; // ISO timestamp
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
  /** Present ⇒ curated catalog entry ('github' | 'asana'); absent ⇒ arbitrary. */
  catalogKey?: string;
  name: string;
  /** '' for curated entries; user-entered https URL otherwise. */
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
  autoSwitchOnFailure: boolean;
  displayNamePreference: DisplayNamePreference;
  customDisplayName: string;
  models: OpenAIModel[];
  prompts: Prompt[];
  tones: Tone[];
  customAgents: CustomAgent[];
  customAgentSources: AgentSource[];
  /** Reusable terminology glossaries for the translation workflow. */
  glossaries: TranslationGlossary[];
  /** User-added translation target languages (flagged in the picker). */
  customLanguages: CustomTranslationLanguage[];
  /** Reusable document format templates (document workflow). */
  documentSpecs: DocumentSpec[];
  /** User-defined document quality criteria (document workflow). */
  documentCriteria: DocumentCustomCriterion[];
  /** MCP servers the user connected (Connectors settings section). */
  mcpServers: McpServerConfig[];
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
  /** User-defined structured-data extraction recipes (Connectors → Recipes). */
  extractionRecipes: ExtractionRecipe[];
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

  // MCP Server Actions (Connectors)
  addMcpServer: (server: McpServerConfig) => void;
  updateMcpServer: (id: string, updates: Partial<McpServerConfig>) => void;
  deleteMcpServer: (id: string) => void;
  setAllowArbitraryMcpServers: (enabled: boolean) => void;
  setMcpArbitraryFlagEnabled: (enabled: boolean) => void;

  // Extraction Recipe Actions
  setExtractionRecipes: (recipes: ExtractionRecipe[]) => void;
  addExtractionRecipe: (recipe: ExtractionRecipe) => void;
  updateExtractionRecipe: (
    id: string,
    updates: Partial<ExtractionRecipe>,
  ) => void;
  deleteExtractionRecipe: (id: string) => void;

  // Hidden Model/Agent Actions
  hideModel: (id: string) => void;
  unhideModel: (id: string) => void;

  // Starred Model/Agent Actions
  starModel: (id: string) => void;
  unstarModel: (id: string) => void;

  // Token usage tracking (see tokenUsageStats)
  recordTokenUsage: (usage: TokenUsageMetadata) => void;
  resetTokenUsageStats: () => void;

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

  // Stop-generation confirmation preferences
  confirmStopFromButton: boolean;
  confirmStopFromKeyboard: boolean;
  setConfirmStopFromButton: (enabled: boolean) => void;
  setConfirmStopFromKeyboard: (enabled: boolean) => void;

  // Reset
  resetSettings: () => void;
}

const DEFAULT_TEMPERATURE = 0.5;
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
      autoSwitchOnFailure: false,
      displayNamePreference: DEFAULT_DISPLAY_NAME_PREFERENCE,
      customDisplayName: DEFAULT_CUSTOM_DISPLAY_NAME,
      models: [],
      prompts: [],
      tones: [],
      customAgents: [],
      customAgentSources: [],
      glossaries: [],
      customLanguages: [],
      documentSpecs: [],
      documentCriteria: [],
      mcpServers: [],
      allowArbitraryMcpServers: false,
      mcpArbitraryFlagEnabled: false,
      hiddenModelIds: [],
      starredModelIds: [],
      tokenUsageStats: {},
      tokenUsageFirstTrackedAt: null,
      modelListSource: null,
      userRegion: null,
      extractionRecipes: [],
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

      // Stop-generation confirmation preferences (both default ON)
      confirmStopFromButton: true,
      confirmStopFromKeyboard: true,

      // Actions
      setTemperature: (temperature) => set({ temperature }),

      setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

      setDefaultModelId: (id) => set({ defaultModelId: id }),

      setDefaultSearchMode: (mode) => set({ defaultSearchMode: mode }),

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

      setMcpArbitraryFlagEnabled: (enabled) =>
        set({ mcpArbitraryFlagEnabled: enabled }),

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
        set({ tokenUsageStats: {}, tokenUsageFirstTrackedAt: null }),

      // Extraction Recipe Actions
      setExtractionRecipes: (recipes) => set({ extractionRecipes: recipes }),

      addExtractionRecipe: (recipe) =>
        set((state) => ({
          extractionRecipes: [...state.extractionRecipes, recipe],
        })),

      updateExtractionRecipe: (id, updates) =>
        set((state) => ({
          extractionRecipes: state.extractionRecipes.map((r) =>
            r.id === id ? { ...r, ...updates } : r,
          ),
        })),

      deleteExtractionRecipe: (id) =>
        set((state) => ({
          extractionRecipes: state.extractionRecipes.filter((r) => r.id !== id),
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

      // Stop-generation confirmation actions
      setConfirmStopFromButton: (enabled) =>
        set({ confirmStopFromButton: enabled }),
      setConfirmStopFromKeyboard: (enabled) =>
        set({ confirmStopFromKeyboard: enabled }),

      resetSettings: () =>
        set({
          temperature: DEFAULT_TEMPERATURE,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          defaultSearchMode: SearchMode.INTELLIGENT,
          displayNamePreference: DEFAULT_DISPLAY_NAME_PREFERENCE,
          customDisplayName: DEFAULT_CUSTOM_DISPLAY_NAME,
          prompts: [],
          tones: [],
          customAgents: [],
          glossaries: [],
          // Wipes connector tokens too — Reset Settings clears everything,
          // and lingering secrets after a "reset" would be worse.
          mcpServers: [],
          allowArbitraryMcpServers: false,
          hiddenModelIds: [],
          starredModelIds: [],
          tokenUsageStats: {},
          tokenUsageFirstTrackedAt: null,
          extractionRecipes: [],
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
          confirmStopFromButton: true,
          confirmStopFromKeyboard: true,
        }),
    }),
    {
      name: 'settings-storage',
      version: 28, // Increment this when schema changes to trigger migrations
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        temperature: state.temperature,
        systemPrompt: state.systemPrompt,
        defaultModelId: state.defaultModelId,
        defaultSearchMode: state.defaultSearchMode,
        autoSwitchOnFailure: state.autoSwitchOnFailure,
        displayNamePreference: state.displayNamePreference,
        customDisplayName: state.customDisplayName,
        prompts: state.prompts,
        tones: state.tones,
        customAgents: state.customAgents,
        customAgentSources: state.customAgentSources,
        glossaries: state.glossaries,
        customLanguages: state.customLanguages,
        documentSpecs: state.documentSpecs,
        documentCriteria: state.documentCriteria,
        // NOTE: mcpArbitraryFlagEnabled is deliberately NOT persisted — it
        // mirrors a LaunchDarkly flag and must re-derive each session.
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
        hiddenModelIds: state.hiddenModelIds,
        starredModelIds: state.starredModelIds,
        tokenUsageStats: state.tokenUsageStats,
        tokenUsageFirstTrackedAt: state.tokenUsageFirstTrackedAt,
        extractionRecipes: state.extractionRecipes,
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
        confirmStopFromButton: state.confirmStopFromButton,
        confirmStopFromKeyboard: state.confirmStopFromKeyboard,
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
          }

          // Defensive: mcpServers must always be an array (same rationale).
          if (!Array.isArray(state.mcpServers)) {
            state.mcpServers = [];
          }

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

          // Defensive: extractionRecipes must always be an array (same
          // rationale as mcpServers) so recipe `.map`/`.filter` never throw.
          if (!Array.isArray(state.extractionRecipes)) {
            state.extractionRecipes = [];
          }
        }
      },
    },
  ),
);
