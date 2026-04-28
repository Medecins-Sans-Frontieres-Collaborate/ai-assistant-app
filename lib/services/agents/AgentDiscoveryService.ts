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

interface CachedEndpoint {
  endpoint: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ENDPOINT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches client useFoundryAgents staleTime

export class AgentDiscoveryService {
  private static instance: AgentDiscoveryService | null = null;
  private cache = new Map<string, CachedAgentList>();
  // Per-user cache mapping (userMail, agentName) → resolved Foundry endpoint.
  // Populated whenever /api/agents discovery succeeds for a user. The chat path
  // reads from this so the host the OBO token gets attached to is never
  // attacker-controlled.
  private userAgentEndpoints = new Map<string, CachedEndpoint>();

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
    this.userAgentEndpoints.clear();
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
    for (const [key, value] of this.userAgentEndpoints) {
      if (now >= value.expiresAt) {
        this.userAgentEndpoints.delete(key);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Per-user agent endpoint resolution
  //
  // The chat pipeline must NEVER trust a `foundryEndpoint` field from the
  // request body — that would let an attacker redirect the user's OBO bearer
  // token to a host they control. Instead, /api/agents populates this cache
  // at discovery time (after RBAC-filtered ARM list), and the chat middleware
  // looks the endpoint up here keyed by (userMail, agentName).
  // ───────────────────────────────────────────────────────────────────

  private endpointCacheKey(
    userMail: string,
    agentName: string,
    sourcePath: string,
  ): string {
    return `${userMail.toLowerCase()}:${sourcePath}:${agentName}`;
  }

  /**
   * Records the discovered endpoint for an agent, scoped to a single user
   * AND source path. Including source path in the key prevents same-named
   * agents from different Foundry projects from overwriting each other.
   * The user must have already passed RBAC at discovery time for this
   * entry to exist — that's the trust boundary.
   */
  cacheUserAgentEndpoint(
    userMail: string | undefined | null,
    agentName: string | undefined | null,
    sourcePath: string | undefined | null,
    endpoint: string | undefined | null,
  ): void {
    if (!userMail || !agentName || !sourcePath || !endpoint) return;
    this.userAgentEndpoints.set(
      this.endpointCacheKey(userMail, agentName, sourcePath),
      {
        endpoint,
        expiresAt: Date.now() + ENDPOINT_CACHE_TTL_MS,
      },
    );
  }

  /**
   * Looks up the discovered endpoint for an agent the given user has
   * accessed within a specific source. Returns null if no cached entry
   * exists or it has expired — caller must fall back to a known-good
   * default and validate the result against the host allow-list.
   */
  lookupUserAgentEndpoint(
    userMail: string | undefined | null,
    agentName: string | undefined | null,
    sourcePath: string | undefined | null,
  ): string | null {
    if (!userMail || !agentName || !sourcePath) return null;
    const key = this.endpointCacheKey(userMail, agentName, sourcePath);
    const entry = this.userAgentEndpoints.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.userAgentEndpoints.delete(key);
      return null;
    }
    return entry.endpoint;
  }

  static reset(): void {
    AgentDiscoveryService.instance = null;
  }
}

export type { DiscoveredAgent, FoundryAgentApp };
