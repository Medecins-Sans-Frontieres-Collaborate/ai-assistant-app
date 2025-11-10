'use client';

import { OpenAIModel, OpenAIModelID } from '@/types/openai';
import { Prompt } from '@/types/prompt';
import { SearchMode } from '@/types/searchMode';
import { Tone } from '@/types/tone';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

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
  models: OpenAIModel[];
  prompts: Prompt[];
  tones: Tone[];
  customAgents: CustomAgent[];

  // Actions
  setTemperature: (temperature: number) => void;
  setSystemPrompt: (prompt: string) => void;
  setDefaultModelId: (id: OpenAIModelID | undefined) => void;
  setDefaultSearchMode: (mode: SearchMode) => void;
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

  // Reset
  resetSettings: () => void;
}

const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_SYSTEM_PROMPT = '';

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      // Initial state
      temperature: DEFAULT_TEMPERATURE,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      defaultModelId: undefined,
      defaultSearchMode: SearchMode.INTELLIGENT, // Privacy-focused intelligent search by default
      models: [],
      prompts: [],
      tones: [],
      customAgents: [],

      // Actions
      setTemperature: (temperature) => set({ temperature }),

      setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),

      setDefaultModelId: (id) => set({ defaultModelId: id }),

      setDefaultSearchMode: (mode) => set({ defaultSearchMode: mode }),

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

      resetSettings: () =>
        set({
          temperature: DEFAULT_TEMPERATURE,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          defaultSearchMode: SearchMode.INTELLIGENT,
          prompts: [],
          tones: [],
          customAgents: [],
        }),
    }),
    {
      name: 'settings-storage',
      version: 2, // Increment this when schema changes to trigger migrations
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        temperature: state.temperature,
        systemPrompt: state.systemPrompt,
        defaultModelId: state.defaultModelId,
        defaultSearchMode: state.defaultSearchMode,
        prompts: state.prompts,
        tones: state.tones,
        customAgents: state.customAgents,
      }),
    },
  ),
);
