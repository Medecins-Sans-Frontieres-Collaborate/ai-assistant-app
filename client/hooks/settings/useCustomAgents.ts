import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Hook that manages custom agents
 * Persistence is handled automatically by Zustand persist middleware
 */
export function useCustomAgents() {
  const customAgents = useSettingsStore((state) => state.customAgents);
  const addCustomAgent = useSettingsStore((state) => state.addCustomAgent);
  const updateCustomAgent = useSettingsStore(
    (state) => state.updateCustomAgent,
  );
  const deleteCustomAgent = useSettingsStore(
    (state) => state.deleteCustomAgent,
  );

  return {
    customAgents,
    addCustomAgent,
    updateCustomAgent,
    deleteCustomAgent,
  };
}
