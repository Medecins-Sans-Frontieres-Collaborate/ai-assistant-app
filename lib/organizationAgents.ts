import * as TablerIcons from '@tabler/icons-react';

import {
  IconComponent,
  OrganizationAgent,
  OrganizationAgentConfig,
  OrganizationAgentType,
} from '@/types/organizationAgent';

import organizationAgentsConfig from '@/config/organization-agents.json';

/**
 * Get icon component from icon name string
 */
export function getIconComponent(iconName: string): IconComponent {
  const icon = (TablerIcons as Record<string, IconComponent>)[iconName];
  return icon || TablerIcons.IconRobot;
}

/**
 * Get all enabled organization agents
 */
export function getOrganizationAgents(): OrganizationAgent[] {
  const config = organizationAgentsConfig as OrganizationAgentConfig;
  return config.agents.filter((agent) => agent.enabled !== false);
}

/**
 * Get organization agent by ID
 */
export function getOrganizationAgentById(
  id: string,
): OrganizationAgent | undefined {
  return getOrganizationAgents().find((agent) => agent.id === id);
}

/**
 * Get organization agents by type
 */
export function getOrganizationAgentsByType(
  type: OrganizationAgentType,
): OrganizationAgent[] {
  return getOrganizationAgents().filter((agent) => agent.type === type);
}

/**
 * Get organization agents by category
 */
export function getOrganizationAgentsByCategory(
  category: string,
): OrganizationAgent[] {
  return getOrganizationAgents().filter((agent) => agent.category === category);
}

/**
 * Get all unique categories
 */
export function getOrganizationAgentCategories(): string[] {
  const categories = new Set<string>();
  getOrganizationAgents().forEach((agent) => {
    if (agent.category) {
      categories.add(agent.category);
    }
  });
  return Array.from(categories);
}

/**
 * Check if an agent ID belongs to an organization agent
 */
export function isOrganizationAgentId(id: string): boolean {
  return id.startsWith('org-');
}

/**
 * Get the organization agent ID from a model ID
 */
export function getOrganizationAgentIdFromModelId(
  modelId: string,
): string | null {
  if (modelId.startsWith('org-')) {
    return modelId.replace('org-', '');
  }
  return null;
}

/**
 * Check if an organization agent is a RAG agent
 */
export function isRAGAgent(agent: OrganizationAgent): boolean {
  return agent.type === 'rag';
}

/**
 * Check if an organization agent is a Foundry agent
 */
export function isFoundryAgent(agent: OrganizationAgent): boolean {
  return agent.type === 'foundry';
}

/**
 * Get all RAG-based organization agents
 */
export function getRAGOrganizationAgents(): OrganizationAgent[] {
  return getOrganizationAgentsByType('rag');
}

/**
 * Get all Foundry-based organization agents
 */
export function getFoundryOrganizationAgents(): OrganizationAgent[] {
  return getOrganizationAgentsByType('foundry');
}
