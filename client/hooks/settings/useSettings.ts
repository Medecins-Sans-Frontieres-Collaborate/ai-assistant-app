import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Hook that manages settings
 * Persistence is handled automatically by Zustand persist middleware
 */
export function useSettings() {
  const store = useSettingsStore();

  return {
    // State
    temperature: store.temperature,
    systemPrompt: store.systemPrompt,
    defaultModelId: store.defaultModelId,
    defaultSearchMode: store.defaultSearchMode,
    models: store.models,
    prompts: store.prompts,
    customAgents: store.customAgents,

    // Actions
    setTemperature: store.setTemperature,
    setSystemPrompt: store.setSystemPrompt,
    setDefaultModelId: store.setDefaultModelId,
    setDefaultSearchMode: store.setDefaultSearchMode,
    setModels: store.setModels,
    addPrompt: store.addPrompt,
    updatePrompt: store.updatePrompt,
    deletePrompt: store.deletePrompt,
    addCustomAgent: store.addCustomAgent,
    updateCustomAgent: store.updateCustomAgent,
    deleteCustomAgent: store.deleteCustomAgent,
    resetSettings: store.resetSettings,
  };
}
