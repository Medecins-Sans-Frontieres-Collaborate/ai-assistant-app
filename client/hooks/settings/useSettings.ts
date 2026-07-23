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
    webSearchOptions: store.webSearchOptions,
    defaultInterpreterMode: store.defaultInterpreterMode,
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
    setWebSearchOptions: store.setWebSearchOptions,
    setDefaultInterpreterMode: store.setDefaultInterpreterMode,
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

    // Active Files Settings
    autoPinActiveFiles: store.autoPinActiveFiles,
    setAutoPinActiveFiles: store.setAutoPinActiveFiles,
    autoInjectPinnedImages: store.autoInjectPinnedImages,
    setAutoInjectPinnedImages: store.setAutoInjectPinnedImages,

    // Stop-generation confirmation preferences
    confirmStopFromButton: store.confirmStopFromButton,
    confirmStopFromKeyboard: store.confirmStopFromKeyboard,
    setConfirmStopFromButton: store.setConfirmStopFromButton,
    setConfirmStopFromKeyboard: store.setConfirmStopFromKeyboard,
  };
}
