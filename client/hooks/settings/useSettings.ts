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
    defaultCodeInterpreterMode: store.defaultCodeInterpreterMode,
    displayNamePreference: store.displayNamePreference,
    customDisplayName: store.customDisplayName,
    models: store.models,
    prompts: store.prompts,
    customAgents: store.customAgents,
    ttsSettings: store.ttsSettings,
    reasoningEffort: store.reasoningEffort,
    verbosity: store.verbosity,
    streamingSpeed: store.streamingSpeed,

    // Actions
    setTemperature: store.setTemperature,
    setSystemPrompt: store.setSystemPrompt,
    setDefaultModelId: store.setDefaultModelId,
    setDefaultSearchMode: store.setDefaultSearchMode,
    setDefaultCodeInterpreterMode: store.setDefaultCodeInterpreterMode,
    setDisplayNamePreference: store.setDisplayNamePreference,
    setCustomDisplayName: store.setCustomDisplayName,
    setModels: store.setModels,
    addPrompt: store.addPrompt,
    updatePrompt: store.updatePrompt,
    deletePrompt: store.deletePrompt,
    addCustomAgent: store.addCustomAgent,
    updateCustomAgent: store.updateCustomAgent,
    deleteCustomAgent: store.deleteCustomAgent,
    setTTSSettings: store.setTTSSettings,
    setReasoningEffort: store.setReasoningEffort,
    setVerbosity: store.setVerbosity,
    resetSettings: store.resetSettings,
  };
}
