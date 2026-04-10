/**
 * Agent Discovery Service
 *
 * Discovers Foundry Agent Applications via the Azure Resource Manager (ARM) API.
 * Returns only agents the authenticated user has RBAC access to (Azure AI User role).
 *
 * The ARM API naturally filters by RBAC — the user's OBO token ensures they only
 * see Agent Applications they're authorized to use.
 */

const ARM_API_VERSION = '2025-10-01-preview';
// const FOUNDRY_AGENTS_API_VERSION = '2025-05-15-preview';

interface FoundryAgentApp {
  /** Agent Application resource name (ARM name) */
  id: string;
  /** Display name from Foundry */
  name: string;
  /** Description from Foundry */
  description: string;
  /** The agent name used for invocation */
  agentName: string;
  /** Whether the agent is enabled */
  isEnabled: boolean;
  /** Base URL for the agent (Foundry endpoint) */
  baseUrl?: string;
  /** Tags (key-value) — used for UI metadata */
  tags: Record<string, string>;
}

interface DiscoveredAgent {
  /** Agent Application name (ARM resource name) */
  id: string;
  /** Display name from Foundry */
  name: string;
  /** Description from Foundry */
  description: string;
  /** The agent name for invocation */
  agentName: string;
  /** Source type */
  type: 'foundry';
  /** ARM resource path this agent was discovered from */
  source?: string;
  /** Foundry project endpoint for invoking this agent */
  foundryEndpoint?: string;
  /** Tabler icon name (from ui-icon tag) */
  icon?: string;
  /** Hex color (from ui-color tag) */
  color?: string;
  /** Cover image path (from ui-image tag) */
  image?: string;
  /** Category for grouping (from ui-category tag) */
  category?: string;
  /** Maintainer info (from ui-maintained-by tag) */
  maintainedBy?: string;
}

interface CachedAgentList {
  agents: DiscoveredAgent[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class AgentDiscoveryService {
  private static instance: AgentDiscoveryService | null = null;
  private cache = new Map<string, CachedAgentList>();

  static getInstance(): AgentDiscoveryService {
    if (!AgentDiscoveryService.instance) {
      AgentDiscoveryService.instance = new AgentDiscoveryService();
    }
    return AgentDiscoveryService.instance;
  }

  /**
   * Lists Agent Applications the user has access to via ARM API.
   * Results are RBAC-filtered because the user's own ARM token is used.
   *
   * @param armToken - User's ARM-scoped OBO token
   * @param resourcePath - ARM resource path for the regional Foundry Resource
   */
  async listUserAgents(
    armToken: string,
    resourcePath: string,
  ): Promise<DiscoveredAgent[]> {
    // Check cache
    const cacheKey = `${this.hashKey(armToken)}:${resourcePath}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.agents;
    }

    const url = `https://management.azure.com${resourcePath}/applications?api-version=${ARM_API_VERSION}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${armToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[AgentDiscoveryService] ARM API error (${response.status}):`,
        body,
      );
      throw new Error(
        `Failed to list agent applications: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    const applications: FoundryAgentApp[] = (data.value || []).map(
      (app: any) => ({
        id: app.name,
        name: app.properties?.displayName || app.name,
        description: app.properties?.description || '',
        agentName: app.properties?.agentName || app.name,
        isEnabled: app.properties?.isEnabled !== false,
        baseUrl: app.properties?.baseUrl,
        tags: app.tags || {},
      }),
    );

    // Map to discovered agents with UI metadata from tags
    const agents: DiscoveredAgent[] = applications
      .filter((app) => app.isEnabled)
      .map((app) => this.mapToDiscoveredAgent(app));

    // Cache results
    this.cache.set(cacheKey, {
      agents,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    console.log(
      `[AgentDiscoveryService] Discovered ${agents.length} agents for user`,
    );

    return agents;
  }

  /**
   * Gets details for a single Agent Application.
   */
  async getAgentDetails(
    armToken: string,
    resourcePath: string,
    appName: string,
  ): Promise<DiscoveredAgent | null> {
    const url = `https://management.azure.com${resourcePath}/applications/${appName}?api-version=${ARM_API_VERSION}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${armToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 404 || response.status === 403) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to get agent details: ${response.status} ${response.statusText}`,
      );
    }

    const app = await response.json();
    const foundryApp: FoundryAgentApp = {
      id: app.name,
      name: app.properties?.displayName || app.name,
      description: app.properties?.description || '',
      agentName: app.properties?.agentName || app.name,
      isEnabled: app.properties?.isEnabled !== false,
      baseUrl: app.properties?.baseUrl,
      tags: app.tags || {},
    };

    return this.mapToDiscoveredAgent(foundryApp);
  }

  /**
   * Maps a Foundry Agent Application to a DiscoveredAgent with UI metadata
   * extracted from ARM resource tags.
   *
   * Tag convention:
   *   ui-icon: "IconCurrencyDollar" (Tabler icon name)
   *   ui-color: "#4190f2" (hex color)
   *   ui-category: "Finance" (grouping category)
   *   ui-image: "/images/agents/netsuite.jpg" (cover image path)
   *   ui-maintained-by: "Finance Team" (maintainer info)
   */
  private mapToDiscoveredAgent(app: FoundryAgentApp): DiscoveredAgent {
    // Derive project endpoint from baseUrl:
    // baseUrl: https://account.services.ai.azure.com/api/projects/default/applications/name
    // endpoint: https://account.services.ai.azure.com/api/projects/default
    const foundryEndpoint = app.baseUrl
      ? app.baseUrl.split('/applications/')[0]
      : undefined;

    return {
      id: app.id,
      name: app.name,
      description: app.description,
      agentName: app.agentName,
      type: 'foundry',
      foundryEndpoint,
      icon: app.tags['ui-icon'] || undefined,
      color: app.tags['ui-color'] || undefined,
      image: app.tags['ui-image'] || undefined,
      category: app.tags['ui-category'] || undefined,
      maintainedBy: app.tags['ui-maintained-by'] || undefined,
    };
  }

  private hashKey(token: string): string {
    let hash = 0;
    for (let i = 0; i < Math.min(token.length, 100); i++) {
      const char = token.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  /**
   * Clears all entries from the cache. Used when user explicitly refreshes.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clears expired entries from the cache.
   */
  cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (now >= value.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  static reset(): void {
    AgentDiscoveryService.instance = null;
  }
}

export type { DiscoveredAgent, FoundryAgentApp };
