/**
 * Agent Discovery Service
 *
 * Discovers Foundry agents the authenticated user has RBAC access to, from
 * two independent planes that are ALWAYS both attempted:
 *
 *  - Control plane (ARM): published "Agent Application" resources under the
 *    project. Carries ui-* tags and the deployment-pinned version. Requires
 *    control-plane read on the preview applications resource type.
 *  - Data plane (Foundry project endpoint): every agent object in the new
 *    agent model (prompt, hosted, workflow, …), published or not. Requires
 *    only a data-plane role (Azure AI User / Foundry User).
 *
 * A user can hold rights on either plane without the other, so a failure on
 * one plane must never block the other — each source's result reports the
 * per-plane outcome so callers can distinguish "empty" from "failed".
 */
import {
  ARM_NAME_PATTERN,
  isValidAccountName,
  isValidFoundryResourcePath,
} from '@/lib/utils/shared/armPath';
import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';

import { env } from '@/config/environment';
import { createHash } from 'crypto';

const ARM_API_VERSION = '2025-10-01-preview';

// Safety cap on data-plane agent listing so a misbehaving/huge project can't
// stall discovery. Far above any realistic agent count per project.
const DATAPLANE_AGENT_LIMIT = 200;
const DATAPLANE_PAGE_LIMIT = 20;

/** Reads optional display metadata without interpreting agent/tool schemas. */
function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

/** Raw shape of an Agent Application as returned by the ARM list endpoint. */
interface ArmAgentApplication {
  name: string;
  properties?: {
    displayName?: string;
    description?: string;
    agentName?: string;
    agents?: Array<{ agentName?: string; agentVersion?: string }>;
    isEnabled?: boolean;
    baseUrl?: string;
  };
  tags?: Record<string, string>;
}

interface FoundryAgentApp {
  /** Agent Application resource name (ARM name) */
  id: string;
  /** Display name from Foundry */
  name: string;
  /** Description from Foundry */
  description: string;
  /** The agent name used for invocation */
  agentName: string;
  /** Version of the agent the Application deployment pins to */
  agentVersion?: string;
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
  /** Agent version pinned by the Application's deployment */
  agentVersion?: string;
  /** Source type — 'foundry' for ARM-discovered agents, 'prompt' for app-defined prompt agents, 'org' for admin-authored org RAG agents */
  type: 'foundry' | 'prompt' | 'm365' | 'org';
  /**
   * New-model agent kind ('prompt' | 'hosted' | 'workflow' | …) from the
   * data-plane definition. Undefined for ARM-only discoveries and
   * app-defined agents. Informational — discovery never filters on it.
   */
  kind?: string;
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
  /** Org RAG agents only — whether the web-search toggle is allowed. */
  allowWebSearch?: boolean;
  /** Org RAG agents only — whether the code-interpreter toggle is allowed. */
  allowCodeInterpreter?: boolean;
  /**
   * Org RAG agents only — true when this id names a static config agent
   * this record overrides; the client replaces the bundled entry.
   */
  overridesStatic?: boolean;
}

/**
 * Outcome of one discovery plane for one source path.
 *
 * 'skipped' means the plane was not attempted by design (feature flag off,
 * no Foundry token, account-only path) — distinct from 'error', where the
 * plane was asked and refused. Callers treat a source as FAILED only when
 * neither plane reports 'ok'.
 */
export type DiscoveryPlaneStatus =
  | { status: 'ok' }
  | {
      status: 'skipped';
      reason: 'flag-disabled' | 'no-foundry-token' | 'no-project-endpoint';
    }
  | { status: 'error'; httpStatus?: number; message: string };

/**
 * Per-source discovery result: the union of both planes' agents plus each
 * plane's outcome, so callers can tell an empty project (both planes ok,
 * zero agents) from a failed listing (no plane ok).
 */
export interface SourceDiscoveryResult {
  agents: DiscoveredAgent[];
  controlPlane: DiscoveryPlaneStatus;
  dataPlane: DiscoveryPlaneStatus;
}

/** One plane's listing attempt: its agents plus how the attempt went. */
interface PlaneListing {
  agents: DiscoveredAgent[];
  outcome: DiscoveryPlaneStatus;
}

interface CachedDiscovery {
  /** Lower-cased user identity the entry belongs to (owner-keyed entries). */
  owner?: string;
  result: SourceDiscoveryResult;
  expiresAt: number;
}

interface CachedEndpoint {
  endpoint: string;
  expiresAt: number;
}

// 1 hour: agent lists change slowly (admins publish new agents occasionally,
// not many times per hour), and the user can force-refresh via the explicit
// reload button on the agent picker. The old 5-min TTL caused asymmetric
// invalidation against the 24h endpoint cache below — the agent list would
// refresh 12x more often than the endpoint mapping, with no observable
// benefit. Cache stampede risk is bounded by `inflightRequests` below.
const CACHE_TTL_MS = 60 * 60 * 1000;
const ENDPOINT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches client useFoundryAgents staleTime

export class AgentDiscoveryService {
  private static instance: AgentDiscoveryService | null = null;
  private cache = new Map<string, CachedDiscovery>();
  /**
   * Cold discoveries in flight, by cache key: concurrent callers for the
   * same user + path (two tabs, a reload during a slow load) share one
   * ARM/data-plane round-trip instead of stampeding.
   */
  private inflightRequests = new Map<string, Promise<SourceDiscoveryResult>>();
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
   * Lists the agents the user can reach under one source path, as the union
   * of the ARM control plane (published Agent Applications) and the Foundry
   * data plane (every new-model agent). Results are RBAC-filtered because
   * the user's own OBO tokens are used on both planes.
   *
   * Never throws for plane-level failures: each plane's outcome is reported
   * on the result so callers can distinguish an empty project from a failed
   * listing. Throws only for an invalid resource path.
   *
   * @param armToken - User's ARM-scoped OBO token
   * @param resourcePath - ARM resource path for the Foundry project
   * @param foundryToken - User's Foundry data-plane OBO token; null skips
   *   the data plane (outcome 'skipped'/'no-foundry-token')
   */
  async listUserAgents(
    armToken: string,
    resourcePath: string,
    foundryToken?: string | null,
    /**
     * The user the tokens belong to (mail or id). When given, the cache is
     * keyed by USER rather than by token hash, so the hourly access-token
     * rotation no longer defeats the hour-long cache. The caller vouches
     * that `armToken` was minted for this user (OBO from their session).
     */
    cacheOwner?: string,
  ): Promise<SourceDiscoveryResult> {
    // Defense-in-depth: callers already validate resourcePath, but re-check
    // here so the ARM URL construction has a locally explicit dataflow guard
    // (and so CodeQL doesn't have to trace through every caller).
    if (!isValidFoundryResourcePath(resourcePath)) {
      throw new Error('Invalid Foundry resource path');
    }

    // Check cache. The result set depends on whether a Foundry token was
    // available too (it gates the data-plane union below), so fold that into
    // the key — otherwise an ARM-only list cached on a call without a
    // Foundry token would be served back on a later call that *does* have
    // one, hiding all new-model agents. Owner-keyed entries fold in the
    // token's PRESENCE; legacy token-keyed entries fold in its identity.
    const owner = cacheOwner?.trim().toLowerCase();
    const foundryKeyPart = owner
      ? foundryToken
        ? 'foundry'
        : 'none'
      : foundryToken
        ? this.hashKey(foundryToken)
        : 'none';
    const cacheKey = owner
      ? `user:${owner}:${foundryKeyPart}:${resourcePath}`
      : `${this.hashKey(armToken)}:${foundryKeyPart}:${resourcePath}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) return inflight;

    const request = this.discoverUncached(
      armToken,
      resourcePath,
      foundryToken,
      cacheKey,
      owner,
    ).finally(() => {
      this.inflightRequests.delete(cacheKey);
    });
    this.inflightRequests.set(cacheKey, request);
    return request;
  }

  private async discoverUncached(
    armToken: string,
    resourcePath: string,
    foundryToken: string | null | undefined,
    cacheKey: string,
    owner: string | undefined,
  ): Promise<SourceDiscoveryResult> {
    // Both planes run concurrently and independently: a user can hold
    // data-plane rights (Azure AI User / Foundry User) without control-plane
    // read on the preview applications resource type, and vice versa. The
    // previous ARM-first flow threw before the data plane could run, hiding
    // every agent from data-plane-only users.
    const attempts = await Promise.allSettled([
      this.listControlPlaneApplications(armToken, resourcePath, foundryToken),
      this.listDataPlaneAgents(foundryToken, resourcePath),
    ]);
    // Contain unexpected decoding/mapping errors as well as HTTP failures.
    // A plane's "never throws" contract alone is not an isolation boundary.
    const [controlPlane, dataPlane] = attempts.map((attempt): PlaneListing => {
      if (attempt.status === 'fulfilled') return attempt.value;
      const message =
        attempt.reason instanceof Error
          ? attempt.reason.message
          : String(attempt.reason);
      console.error(
        `[AgentDiscoveryService] Discovery plane failed for ${resourcePath}: ${message}`,
      );
      return { agents: [], outcome: { status: 'error', message } };
    });

    // Union with ARM winning on conflicts: the Application resource carries
    // ui-* tags and the deployment-pinned version.
    const agents = [...controlPlane.agents];
    const seen = new Set(agents.map((a) => a.agentName));
    for (const dp of dataPlane.agents) {
      if (!seen.has(dp.agentName)) {
        seen.add(dp.agentName);
        agents.push(dp);
      }
    }

    const result: SourceDiscoveryResult = {
      agents,
      controlPlane: controlPlane.outcome,
      dataPlane: dataPlane.outcome,
    };

    // Never pin an incomplete list for an hour. In particular, ARM can
    // successfully return [] while the data plane fails to decode an agent.
    // A later retry must reach Azure instead of repeating that false empty.
    if (
      controlPlane.outcome.status !== 'error' &&
      dataPlane.outcome.status !== 'error' &&
      (controlPlane.outcome.status === 'ok' ||
        dataPlane.outcome.status === 'ok')
    ) {
      this.cache.set(cacheKey, {
        result,
        expiresAt: Date.now() + CACHE_TTL_MS,
        ...(owner && { owner }),
      });
    }

    console.log(
      `[AgentDiscoveryService] Discovered ${agents.length} agents ` +
        `(controlPlane=${controlPlane.outcome.status}, dataPlane=${dataPlane.outcome.status}) source=${resourcePath}`,
    );

    return result;
  }

  /**
   * Control plane: lists published Agent Application resources via ARM.
   * Failures are reported on the outcome, never thrown — the caller unions
   * this with the data-plane listing regardless.
   */
  private async listControlPlaneApplications(
    armToken: string,
    resourcePath: string,
    foundryToken: string | null | undefined,
  ): Promise<PlaneListing> {
    const url = `https://management.azure.com${resourcePath}/applications?api-version=${ARM_API_VERSION}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${armToken}`,
          'Content-Type': 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[AgentDiscoveryService] ARM request failed: ${message}`);
      return { agents: [], outcome: { status: 'error', message } };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(
        `[AgentDiscoveryService] ARM API error (${response.status}):`,
        body,
      );
      return {
        agents: [],
        outcome: {
          status: 'error',
          httpStatus: response.status,
          message: `Failed to list agent applications: ${response.status} ${response.statusText}`,
        },
      };
    }

    // Parse failures must stay inside this plane: a throw here would reject
    // the Promise.all in discoverUncached and take the healthy data-plane
    // listing down with it — the exact coupling this split removes.
    let data: { value?: ArmAgentApplication[] };
    try {
      data = (await response.json()) as { value?: ArmAgentApplication[] };
      if (!data || !Array.isArray(data.value)) {
        throw new Error('Expected an ARM value array');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[AgentDiscoveryService] Malformed ARM response: ${message}`,
      );
      return {
        agents: [],
        outcome: { status: 'error', message: `Malformed ARM response` },
      };
    }
    const applications: FoundryAgentApp[] = (data.value || []).map((app) => ({
      id: app.name,
      name: app.properties?.displayName || app.name,
      description: app.properties?.description || '',
      agentName:
        app.properties?.agents?.[0]?.agentName ||
        app.properties?.agentName ||
        app.name,
      agentVersion: app.properties?.agents?.[0]?.agentVersion,
      isEnabled: app.properties?.isEnabled !== false,
      baseUrl: app.properties?.baseUrl,
      tags: app.tags || {},
    }));

    const enabledApps = applications.filter((app) => app.isEnabled);

    // Best-effort enrichment from the Foundry data plane: each Application
    // wraps a project-level agent that owns the real name and description.
    // ARM only exposes the Application's slug and (often null) description.
    const agents: DiscoveredAgent[] = await Promise.all(
      enabledApps.map(async (app) => {
        const dp = foundryToken
          ? await this.fetchDataPlaneAgent(foundryToken, app).catch(() => null)
          : null;
        return this.mapToDiscoveredAgent(app, dp);
      }),
    );

    return { agents, outcome: { status: 'ok' } };
  }

  /**
   * Data plane: lists every agent object in the new model (prompt, hosted,
   * workflow, …) under the user's Foundry OBO token — including agents the
   * control plane can't see (new-model agents and legacy unpublished ones).
   * Skips are reported distinctly from errors so callers can tell "not
   * attempted" from "refused".
   */
  private async listDataPlaneAgents(
    foundryToken: string | null | undefined,
    resourcePath: string,
  ): Promise<PlaneListing> {
    if (!env.FOUNDRY_DATAPLANE_DISCOVERY) {
      return {
        agents: [],
        outcome: { status: 'skipped', reason: 'flag-disabled' },
      };
    }
    if (!foundryToken) {
      return {
        agents: [],
        outcome: { status: 'skipped', reason: 'no-foundry-token' },
      };
    }
    const projectEndpoint = this.deriveProjectEndpoint(resourcePath);
    if (!projectEndpoint) {
      // Account-only paths have no project to list; not an error.
      return {
        agents: [],
        outcome: { status: 'skipped', reason: 'no-project-endpoint' },
      };
    }

    try {
      const agents = await this.listProjectAgentsDataPlane(
        foundryToken,
        projectEndpoint,
      );
      return { agents, outcome: { status: 'ok' } };
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[AgentDiscoveryService] Data-plane listing failed for ${resourcePath}: ${message}`,
      );
      return {
        agents: [],
        outcome: {
          status: 'error',
          ...(typeof statusCode === 'number' && { httpStatus: statusCode }),
          message,
        },
      };
    }
  }

  /**
   * Gets details for a single Agent Application.
   */
  async getAgentDetails(
    armToken: string,
    resourcePath: string,
    appName: string,
  ): Promise<DiscoveredAgent | null> {
    // See listUserAgents — explicit local validation for both path components.
    if (!isValidFoundryResourcePath(resourcePath)) {
      throw new Error('Invalid Foundry resource path');
    }
    // ARM Application names follow the same constraint as account names.
    if (!isValidAccountName(appName)) {
      throw new Error('Invalid agent application name');
    }
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

    return this.mapToDiscoveredAgent(foundryApp, null);
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
  private mapToDiscoveredAgent(
    app: FoundryAgentApp,
    dataPlane: {
      name?: string;
      description?: string;
      version?: string;
    } | null,
  ): DiscoveredAgent {
    // `baseUrl` comes from an ARM response a THIRD-PARTY project admin
    // controls (users connect arbitrary Foundry projects). An endpoint on a
    // disallowed host must never be surfaced: it would be anchored into the
    // per-user endpoint cache and only the chat middleware's allow-list
    // check would stand between it and the user's bearer token.
    const rawEndpoint = app.baseUrl
      ? app.baseUrl.split('/applications/')[0]
      : undefined;
    const foundryEndpoint =
      rawEndpoint && isAllowedFoundryHost(rawEndpoint)
        ? rawEndpoint
        : undefined;

    // Foundry has no display-name field separate from the slug, so prettify
    // the slug for the picker. The raw slug is preserved on `id` for the subtitle.
    const prettified = this.prettifyAgentName(
      dataPlane?.name?.trim() || app.name,
    );

    return {
      id: app.id,
      name: prettified,
      description: dataPlane?.description?.trim() || app.description,
      agentName: app.agentName,
      agentVersion: dataPlane?.version || app.agentVersion,
      type: 'foundry',
      foundryEndpoint,
      icon: app.tags['ui-icon'] || undefined,
      color: app.tags['ui-color'] || undefined,
      image: app.tags['ui-image'] || undefined,
      category: app.tags['ui-category'] || undefined,
      maintainedBy: app.tags['ui-maintained-by'] || undefined,
    };
  }

  private async fetchDataPlaneAgent(
    foundryToken: string,
    app: FoundryAgentApp,
  ): Promise<{
    name?: string;
    description?: string;
    version?: string;
  } | null> {
    if (!app.baseUrl || !app.agentName) return null;
    const projectEndpoint = app.baseUrl.split('/applications/')[0];
    if (!projectEndpoint) return null;
    // The user's Foundry bearer token is attached to this request, and
    // `baseUrl` is controlled by whoever administers the connected project —
    // never send the token to a host outside the Foundry allow-list.
    if (!isAllowedFoundryHost(projectEndpoint)) return null;
    if (!isValidAccountName(app.agentName)) return null;

    try {
      const res = await fetch(
        `${projectEndpoint}/agents/${app.agentName}?api-version=v1`,
        {
          headers: {
            Authorization: `Bearer ${foundryToken}`,
            'Content-Type': 'application/json',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;
      const body = await res.json();
      const latest = body?.versions?.latest;
      // `versions.latest.version` is the latest published version. The
      // Application's deployment may pin to an older version; getting the
      // pinned version exactly requires a separate /agentdeployments call.
      // Latest covers the common case where the Application auto-deploys.
      return {
        name: latest?.name || body?.name,
        description: latest?.description,
        version: latest?.version,
      };
    } catch {
      return null;
    }
  }

  /**
   * Prettifies an agent slug for the picker: hyphens/underscores → spaces,
   * title-cased. Foundry exposes no separate display name from the slug.
   */
  private prettifyAgentName(raw: string): string {
    return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Derives the Foundry data-plane PROJECT endpoint for an ARM resource path.
   *
   * New-model agents have no ARM "Agent Application" resource to read a baseUrl
   * from, so we construct the documented project endpoint
   * (`https://{account}.services.ai.azure.com/api/projects/{project}`) from the
   * account + project names in the ARM path. Account-only paths (no project
   * segment) can't be listed per-project and return null. The constructed
   * endpoint is validated against the Foundry host allow-list before use.
   */
  private deriveProjectEndpoint(resourcePath: string): string | null {
    const account = resourcePath.match(
      new RegExp(`/accounts/(${ARM_NAME_PATTERN})`),
    )?.[1];
    const project = resourcePath.match(
      new RegExp(`/projects/(${ARM_NAME_PATTERN})`),
    )?.[1];
    if (!account || !project) return null;
    const endpoint = `https://${account}.services.ai.azure.com/api/projects/${project}`;
    return isAllowedFoundryHost(endpoint) ? endpoint : null;
  }

  /**
   * Lists agent objects via the Foundry data plane (new agent object model),
   * surfacing new-model and legacy *unpublished* agents that the ARM control
   * plane can't see. Runs under the user's Foundry OBO token, so results are
   * RBAC-filtered at project scope. Reads only discovery metadata from the
   * REST response, deliberately avoiding the SDK's deep tool deserializers:
   * a valid new Foundry tool schema can crash those generated deserializers
   * (observed on MIC: undefined.project_connection_id), hiding every agent.
   * HTTP, malformed-envelope and pagination failures are reported by caller.
   */
  private async listProjectAgentsDataPlane(
    foundryToken: string,
    projectEndpoint: string,
  ): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    const cursors = new Set<string>();
    const seenNames = new Set<string>();
    // Bound total work independently of the number of accepted agents.
    // Fresh cursors plus invalid/duplicate records cannot extend discovery
    // indefinitely. All pages share a wall-clock budget too.
    const deadline = AbortSignal.timeout(20_000);
    let pages = 0;
    let after: string | undefined;
    do {
      if (++pages > DATAPLANE_PAGE_LIMIT) {
        throw new Error(
          'Foundry agent listing exceeded the pagination safety limit',
        );
      }
      const url = new URL(`${projectEndpoint}/agents`);
      url.searchParams.set('api-version', 'v1');
      url.searchParams.set(
        'limit',
        String(Math.min(100, DATAPLANE_AGENT_LIMIT - agents.length)),
      );
      if (after) url.searchParams.set('after', after);
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${foundryToken}` },
        redirect: 'error',
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`Foundry agent listing HTTP ${response.status}`),
          { statusCode: response.status },
        );
      }
      const body = await response.json();
      if (!body || !Array.isArray(body.data)) {
        throw new Error('Malformed Foundry agent listing: expected data array');
      }
      for (const a of body.data) {
        const agentName = metadataString(a?.name);
        if (!agentName || seenNames.has(agentName)) continue;
        seenNames.add(agentName);

        // `agent_card` carries consumer-facing name/description in the new model
        // (there are no ARM tags for UI metadata, so icon/color fall back to the
        // picker's default).
        const card = (
          a as { agent_card?: { name?: string; description?: string } }
        ).agent_card;
        const latest = a?.versions?.latest as
          | {
              version?: string;
              description?: string;
              definition?: { kind?: string };
            }
          | undefined;

        agents.push({
          id: agentName,
          name: this.prettifyAgentName(metadataString(card?.name) || agentName),
          description:
            metadataString(card?.description) ||
            metadataString(latest?.description) ||
            '',
          agentName,
          agentVersion: metadataString(latest?.version),
          type: 'foundry',
          kind: metadataString(latest?.definition?.kind),
          foundryEndpoint: projectEndpoint,
        });

        if (agents.length >= DATAPLANE_AGENT_LIMIT) break;
      }
      if (!body.has_more || agents.length >= DATAPLANE_AGENT_LIMIT) break;
      if (
        typeof body.last_id !== 'string' ||
        !body.last_id ||
        cursors.has(body.last_id)
      ) {
        throw new Error(
          'Malformed Foundry agent listing: missing or repeated pagination cursor',
        );
      }
      cursors.add(body.last_id);
      after = body.last_id;
    } while (after);
    return agents;
  }

  /**
   * Derives a cache-key component from a token. This is a per-user trust
   * boundary: a collision would serve one user's RBAC-filtered agent list to
   * another user, so we digest the FULL token with SHA-256 rather than folding
   * a truncated prefix into a 32-bit integer (which collided in practice).
   */
  private hashKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Clears all entries from the cache (every user on this replica). Kept
   * for operational resets; a user's own reload button should call
   * {@link clearCacheForUser} so one person's refresh doesn't cold-start
   * discovery for everyone.
   */
  clearCache(): void {
    this.cache.clear();
    this.userAgentEndpoints.clear();
  }

  /**
   * Clears one user's discovery results and endpoint anchors. Owner-keyed
   * list entries are matched by owner; legacy token-keyed entries can't be
   * attributed and are left to expire.
   */
  clearCacheForUser(user: string | null | undefined): void {
    const owner = user?.trim().toLowerCase();
    if (!owner) return;
    for (const [key, value] of this.cache) {
      if (value.owner === owner) this.cache.delete(key);
    }
    const prefix = `${owner}:`;
    for (const key of this.userAgentEndpoints.keys()) {
      if (key.startsWith(prefix)) this.userAgentEndpoints.delete(key);
    }
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
