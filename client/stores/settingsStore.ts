'use client';

import { CodeInterpreterMode } from '@/types/codeInterpreter';
import {
  DEFAULT_MODEL_ORDER,
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
  defaultCodeInterpreterMode: CodeInterpreterMode;
  autoSwitchOnFailure: boolean;
  displayNamePreference: DisplayNamePreference;
  customDisplayName: string;
  models: OpenAIModel[];
  prompts: Prompt[];
  tones: Tone[];
  customAgents: CustomAgent[];
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
  setDefaultCodeInterpreterMode: (mode: CodeInterpreterMode) => void;
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

  // Custom Agent Actions
  setCustomAgents: (agents: CustomAgent[]) => void;
  addCustomAgent: (agent: CustomAgent) => void;
  updateCustomAgent: (id: string, updates: Partial<CustomAgent>) => void;
  deleteCustomAgent: (id: string) => void;

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
      defaultCodeInterpreterMode: CodeInterpreterMode.INTELLIGENT, // Intelligent Code Interpreter routing by default
      autoSwitchOnFailure: false,
      displayNamePreference: DEFAULT_DISPLAY_NAME_PREFERENCE,
      customDisplayName: DEFAULT_CUSTOM_DISPLAY_NAME,
      models: [],
      prompts: [],
      tones: [],
      customAgents: [],
      streamingSpeed: DEFAULT_STREAMING_SPEED,
      includeUserInfoInPrompt: false, // Default off for privacy
      preferredName: '',
      userContext: '',

      // Model ordering initial state
      modelOrderMode: 'usage',
      customModelOrder: [],
      modelUsageStats: {},
      consecutiveModelUsage: { modelId: null, count: 0 },

      // Organization preference (null = auto-detect from email)
      organizationPreference: null,

      // TTS settings
      ttsSettings: DEFAULT_TTS_SETTINGS,

      // Reasoning model settings (undefined = use model defaults)
      reasoningEffort: undefined,
      verbosity: undefined,

      // Actions
      setTemperature: (temperature) => set({ temperature }),

      setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

      setDefaultModelId: (id) => set({ defaultModelId: id }),

      setDefaultSearchMode: (mode) => set({ defaultSearchMode: mode }),

      setDefaultCodeInterpreterMode: (mode) =>
        set({ defaultCodeInterpreterMode: mode }),

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

      resetSettings: () =>
        set({
          temperature: DEFAULT_TEMPERATURE,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          defaultSearchMode: SearchMode.INTELLIGENT,
          defaultCodeInterpreterMode: CodeInterpreterMode.INTELLIGENT,
          displayNamePreference: DEFAULT_DISPLAY_NAME_PREFERENCE,
          customDisplayName: DEFAULT_CUSTOM_DISPLAY_NAME,
          prompts: [],
          tones: [],
          customAgents: [],
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
        }),
    }),
    {
      name: 'settings-storage',
      version: 14, // Increment this when schema changes to trigger migrations
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        temperature: state.temperature,
        systemPrompt: state.systemPrompt,
        defaultModelId: state.defaultModelId,
        defaultSearchMode: state.defaultSearchMode,
        defaultCodeInterpreterMode: state.defaultCodeInterpreterMode,
        autoSwitchOnFailure: state.autoSwitchOnFailure,
        displayNamePreference: state.displayNamePreference,
        customDisplayName: state.customDisplayName,
        prompts: state.prompts,
        tones: state.tones,
        customAgents: state.customAgents,
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

        // Version 13 → 14: Add defaultCodeInterpreterMode
        if (version < 14) {
          if (state.defaultCodeInterpreterMode === undefined) {
            state.defaultCodeInterpreterMode = CodeInterpreterMode.INTELLIGENT;
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
        }
      },
    },
  ),
);
