import { CustomAgentExport } from '@/types/export';

import { CustomAgent } from '@/client/stores/settingsStore';

/**
 * Exports custom agents to a JSON file
 */
export const exportCustomAgents = (customAgents: CustomAgent[]): void => {
  const exportData: CustomAgentExport = {
    version: 1,
    customAgents,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `custom-agents-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Exports a single custom agent to a JSON file
 */
export const exportSingleCustomAgent = (agent: CustomAgent): void => {
  const exportData: CustomAgentExport = {
    version: 1,
    customAgents: [agent],
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${agent.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Validates custom agent import data
 */
export const validateCustomAgentImport = (
  data: any,
): { valid: boolean; error?: string; data?: CustomAgentExport } => {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid file format' };
  }

  if (data.version !== 1) {
    return {
      valid: false,
      error: `Unsupported version: ${data.version}. Expected version 1.`,
    };
  }

  if (!Array.isArray(data.customAgents)) {
    return { valid: false, error: 'Missing or invalid customAgents array' };
  }

  // Validate each custom agent has required fields
  for (const agent of data.customAgents) {
    if (!agent.id || !agent.name || !agent.agentId || !agent.baseModelId) {
      return {
        valid: false,
        error: 'Invalid custom agent data: missing required fields',
      };
    }
  }

  return { valid: true, data: data as CustomAgentExport };
};

/**
 * Imports custom agents from JSON data
 * Returns the imported agents with regenerated IDs to avoid conflicts
 */
export const importCustomAgents = (
  data: CustomAgentExport,
  existingAgents: CustomAgent[],
): { agents: CustomAgent[]; conflicts: string[] } => {
  const existingNames = new Set(
    existingAgents.map((a) => a.name.toLowerCase()),
  );
  const existingAgentIds = new Set(existingAgents.map((a) => a.agentId));
  const conflicts: string[] = [];
  const importedAgents: CustomAgent[] = [];

  for (const agent of data.customAgents) {
    // Check for name conflicts
    const hasNameConflict = existingNames.has(agent.name.toLowerCase());

    // Check for agent ID conflicts (same Azure agent being imported twice)
    const hasAgentIdConflict = existingAgentIds.has(agent.agentId);

    if (hasNameConflict || hasAgentIdConflict) {
      conflicts.push(
        `"${agent.name}" ${hasNameConflict ? '(name conflict)' : ''} ${hasAgentIdConflict ? '(agent ID already exists)' : ''}`.trim(),
      );
    }

    // Import the agent with a new internal ID but keep the Azure agent ID
    importedAgents.push({
      ...agent,
      id: `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date().toISOString(),
    });
  }

  return { agents: importedAgents, conflicts };
};
