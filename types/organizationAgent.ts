import { ForwardRefExoticComponent, RefAttributes, SVGProps } from 'react';

/**
 * Organization Agent Types
 *
 * Organization agents can be either:
 * - 'rag': RAG-enabled agents with AI Search integration
 * - 'foundry': Azure AI Foundry agents (like custom agents but org-provided)
 */
export type OrganizationAgentType = 'rag' | 'foundry';

/**
 * RAG Configuration for knowledge base agents
 */
export interface RAGConfig {
  /** Override search endpoint (defaults to SEARCH_ENDPOINT env var) */
  searchEndpoint?: string;
  /** Override search index (defaults to SEARCH_INDEX env var) */
  searchIndex?: string;
  /** Semantic search configuration name */
  semanticConfig?: string;
  /** Number of results to retrieve */
  topK?: number;
}

/**
 * Organization Agent Configuration
 *
 * Organization agents are pre-configured agents provided by the organization.
 * They are defined in config/organization-agents.json and are read-only for users.
 *
 * Supports two modes:
 * - RAG agents: Knowledge base search with custom system prompts
 * - Foundry agents: Azure AI Foundry agents with pre-configured tools
 */
export interface OrganizationAgent {
  /** Unique identifier for the agent */
  id: string;
  /** Display name */
  name: string;
  /** Description shown in the UI */
  description: string;
  /** Icon name from @tabler/icons-react (e.g., "IconNews", "IconBook", "IconRobot") */
  icon: string;
  /** Theme color (hex) */
  color: string;
  /** Optional cover image path (relative to public folder, e.g., "/images/agents/comms.jpg") */
  image?: string;
  /** Organization or team that maintains this agent */
  maintainedBy?: string;
  /** Agent type: 'rag' for knowledge base, 'foundry' for AI Foundry agent */
  type: OrganizationAgentType;
  /** Whether the agent is enabled */
  enabled?: boolean;
  /** Category for grouping in the UI */
  category?: string;

  // ========================================
  // RAG Agent Fields (type: 'rag')
  // ========================================
  /** System prompt that defines the agent's behavior (RAG agents only) */
  systemPrompt?: string;
  /** Knowledge base sources for attribution (RAG agents only) */
  sources?: Array<{
    name: string;
    url: string;
    updated?: string;
  }>;
  /** RAG configuration (RAG agents only) */
  ragConfig?: RAGConfig;
  /** Allow web search alongside RAG (RAG agents only) */
  allowWebSearch?: boolean;

  // ========================================
  // Foundry Agent Fields (type: 'foundry')
  // ========================================
  /** Azure AI Foundry agent ID (Foundry agents only) */
  agentId?: string;

  // ========================================
  // Common Optional Fields
  // ========================================
  /** Base model to use (defaults to gpt-4.1 for RAG, ignored for Foundry) */
  baseModelId?: string;
}

/**
 * Organization agent config file format
 */
export interface OrganizationAgentConfig {
  version: number;
  agents: OrganizationAgent[];
}

/**
 * Tabler icon props interface (matching @tabler/icons-react)
 */
export interface TablerIconProps extends Partial<
  Omit<SVGProps<SVGSVGElement>, 'stroke'>
> {
  size?: string | number;
  stroke?: string | number;
  title?: string;
}

/**
 * Icon component type for Tabler icons
 */
export type IconComponent = ForwardRefExoticComponent<
  TablerIconProps & RefAttributes<SVGSVGElement>
>;
