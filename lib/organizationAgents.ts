import {
  IconBriefcase,
  IconBuildingBank,
  IconCalculator,
  IconChartBar,
  IconCode,
  IconCurrencyDollar,
  IconDatabase,
  IconFileText,
  IconHeartbeat,
  IconMail,
  IconMessage,
  IconNews,
  IconRobot,
  IconSearch,
  IconShield,
  IconUsers,
  IconWorld,
} from '@tabler/icons-react';

import {
  IconComponent,
  OrganizationAgent,
  OrganizationAgentConfig,
  OrganizationAgentType,
} from '@/types/organizationAgent';

import organizationAgentsConfig from '@/config/organization-agents.json';

/**
 * Registry of icon components available for organization/Foundry agents.
 * Add new icons here as needed — avoids importing the entire Tabler library.
 */
const ICON_REGISTRY: Record<string, IconComponent> = {
  IconBriefcase,
  IconBuildingBank,
  IconCalculator,
  IconChartBar,
  IconCode,
  IconCurrencyDollar,
  IconDatabase,
  IconFileText,
  IconHeartbeat,
  IconMail,
  IconMessage,
  IconNews,
  IconRobot,
  IconSearch,
  IconShield,
  IconUsers,
  IconWorld,
};

/**
 * Get icon component from icon name string.
 * Falls back to IconRobot for unknown icon names.
 */
export function getIconComponent(iconName: string): IconComponent {
  return ICON_REGISTRY[iconName] || IconRobot;
}

/**
 * Get all enabled organization agents (both RAG and Foundry from static config).
 * For Foundry agents discovered dynamically from ARM API, use getFoundryAgents() instead.
 */
export function getOrganizationAgents(): OrganizationAgent[] {
  const config = organizationAgentsConfig as OrganizationAgentConfig;
  return config.agents.filter((agent) => agent.enabled !== false);
}

/**
 * Get only RAG agents from static config.
 * RAG agents are app-defined with system prompts and search config —
 * they don't exist in Foundry and are always loaded from organization-agents.json.
 */
export function getRAGAgents(): OrganizationAgent[] {
  return getOrganizationAgents().filter((agent) => agent.type === 'rag');
}

/**
 * Get organization agent by ID (searches both static RAG and static Foundry agents)
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
 * Check if an agent ID belongs to a dynamically discovered Foundry agent
 */
export function isFoundryAgentId(id: string): boolean {
  return id.startsWith('foundry-');
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
 * Get the Foundry agent ID from a model ID
 */
export function getFoundryAgentIdFromModelId(modelId: string): string | null {
  if (modelId.startsWith('foundry-')) {
    return modelId.replace('foundry-', '');
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
 * Get all Foundry-based organization agents from static config.
 * @deprecated Use dynamic discovery via /api/agents for Foundry agents
 */
export function getFoundryOrganizationAgents(): OrganizationAgent[] {
  return getOrganizationAgentsByType('foundry');
}
