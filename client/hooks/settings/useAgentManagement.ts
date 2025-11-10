import { useCallback } from 'react';

import { useCustomAgents } from '@/client/hooks/settings/useCustomAgents';

import { CustomAgent } from '@/client/stores/settingsStore';

/**
 * Custom hook to manage custom agent CRUD operations
 * Centralizes agent management logic
 */
export function useAgentManagement() {
  const { customAgents, addCustomAgent, updateCustomAgent, deleteCustomAgent } =
    useCustomAgents();

  const handleSaveAgent = useCallback(
    (agent: CustomAgent) => {
      if (agent.id && customAgents.find((a) => a.id === agent.id)) {
        updateCustomAgent(agent.id, agent);
      } else {
        addCustomAgent(agent);
      }
    },
    [customAgents, addCustomAgent, updateCustomAgent],
  );

  const handleImportAgents = useCallback(
    (agents: CustomAgent[]) => {
      agents.forEach((agent) => {
        addCustomAgent(agent);
      });
    },
    [addCustomAgent],
  );

  const handleDeleteAgent = useCallback(
    (agentId: string) => {
      deleteCustomAgent(agentId);
    },
    [deleteCustomAgent],
  );

  return {
    customAgents,
    handleSaveAgent,
    handleImportAgents,
    handleDeleteAgent,
  };
}
