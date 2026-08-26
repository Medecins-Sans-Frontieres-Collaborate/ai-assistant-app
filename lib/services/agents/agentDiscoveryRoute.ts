/**
 * Shared implementation behind the agent discovery routes
 * (docs/AGENTS_DISCOVERY_SPLIT_PLAN.md):
 *
 *   GET /api/agents          fast half — app-defined agents (prompt, M365,
 *                            knowledge) + suppressed static ids; tens of ms
 *   GET /api/agents/foundry  slow half — OBO → ARM/Foundry discovery →
 *                            access filter → endpoint anchors; seconds cold
 *   GET /api/agents?include=foundry  the legacy combined payload, kept for
 *                            one release while clients move over
 *
 * Every piece takes the session (or its mail) explicitly so the three
 * entry points share one implementation and one test surface.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  M365_AGENT_SOURCE,
  ORG_AGENT_SOURCE,
  PROMPT_AGENT_SOURCE,
} from '@/lib/services/agentAccess/types';
import {
  AgentDiscoveryService,
  DiscoveredAgent,
} from '@/lib/services/agents/AgentDiscoveryService';
import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';
import { createAppIdentityCredential } from '@/lib/services/auth/appIdentityCredential';
import {
  getServeableAdminOrgAgents,
  getSuppressedStaticAgentIds,
} from '@/lib/services/orgAgents/orgAgentRegistry';

import { isValidFoundryResourcePath } from '@/lib/utils/shared/armPath';

import { getAccessTokenForOBO } from '@/auth';
import { getOrganizationAgents } from '@/lib/organizationAgents';

// ---------------------------------------------------------------------------
// Server-Timing
// ---------------------------------------------------------------------------

/**
 * Minimal Server-Timing accumulator so the split's two halves report where
 * their time goes (`groups`, `lookups`, `obo`, `arm`, `rules`, …). Read it
 * in the browser's network panel or App Insights — this is what decides
 * whether the bulk data-plane listing is worth doing.
 */
export class ServerTiming {
  private readonly entries: { name: string; ms: number }[] = [];

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.entries.push({ name, ms: performance.now() - started });
    }
  }

  header(): string {
    return this.entries
      .map((e) => `${e.name};dur=${e.ms.toFixed(1)}`)
      .join(', ');
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface DiscoveryPaths {
  regionalPath: string | null;
  officePaths: string[];
  /** Deduplicated regional + office + validated custom paths. */
  allPaths: string[];
}

/**
 * Office-scoped discovery returns three buckets: the regional default, the
 * user's office extras (e.g. MSF USA), and their manually added sources
 * (`?sources=`). Custom entries must match the strict Foundry ARM
 * resource-path shape — invalid ones are dropped silently to prevent
 * path-injection / SSRF against management.azure.com.
 */
export function resolveDiscoveryPaths(
  request: NextRequest,
  userMail: string | undefined,
): DiscoveryPaths {
  const { regionalPath, officePaths } =
    OfficeResolver.getDiscoveryPathsForUser(userMail);
  const sourcesParam = request.nextUrl.searchParams.get('sources');
  const requestedSources = sourcesParam
    ? sourcesParam.split(',').filter(Boolean)
    : [];
  const customSourcePaths = requestedSources.filter((p) =>
    isValidFoundryResourcePath(p),
  );
  if (customSourcePaths.length !== requestedSources.length) {
    console.warn(
      `[/api/agents] Dropped ${requestedSources.length - customSourcePaths.length} invalid source path(s)`,
    );
  }
  const orderedPaths = [
    ...(regionalPath ? [regionalPath] : []),
    ...officePaths,
    ...customSourcePaths,
  ];
  return {
    regionalPath,
    officePaths,
    allPaths: Array.from(new Set(orderedPaths)),
  };
}

export function cacheOwnerFor(session: Session): string {
  return session.user.mail?.trim().toLowerCase() || session.user.id;
}

// ---------------------------------------------------------------------------
// App-defined agents (the fast half)
// ---------------------------------------------------------------------------

/**
 * Prompt-agent entries from the AgentAccessService snapshot (hot path —
 * never reads storage directly), access-filtered for the user. The wire
 * shape deliberately omits systemPrompt and modelId: those are admin-only
 * fields; the server resolves them from botId at invocation time.
 * 'unavailable' passes through like the Foundry discovery filter (this is a
 * visibility-only surface — in practice an unavailable snapshot carries no
 * prompt agents anyway). Empty when the feature is disabled.
 */
async function getVisiblePromptAgentEntries(
  userMail: string | undefined,
): Promise<DiscoveredAgent[]> {
  const accessService = AgentAccessService.getInstance();
  if (!accessService.isEnabled()) return [];
  await accessService.ensureFresh();
  const entries: DiscoveredAgent[] = [];
  for (const promptAgent of accessService.getPromptAgents()) {
    const { decision } = accessService.evaluateAccess({
      userMail,
      source: PROMPT_AGENT_SOURCE,
      agentName: promptAgent.id,
    });
    if (decision !== 'deny') {
      entries.push({
        id: promptAgent.id,
        name: promptAgent.name,
        description: promptAgent.description,
        agentName: promptAgent.id,
        source: PROMPT_AGENT_SOURCE,
        type: 'prompt',
      });
    }
  }
  return entries;
}

/**
 * M365 file-backed agents, filtered by the same layer-1 rules. Deliberately
 * visibility-only: users who cannot open the base files still SEE the agent
 * (requirement 1 of the design) — the preflight endpoint + chat-time trim
 * handle layer 2.
 *
 * Never-indexed agents are the exception: with no successfully indexed
 * source there is nothing to retrieve for ANY user, so every chat can only
 * answer "I can't access anything". They stay out of discovery until an
 * index run succeeds; the admin page still lists them.
 */
async function getVisibleM365AgentEntries(
  userMail: string | undefined,
): Promise<DiscoveredAgent[]> {
  const accessService = AgentAccessService.getInstance();
  if (!accessService.isEnabled()) return [];
  await accessService.ensureFresh();
  const entries: DiscoveredAgent[] = [];
  for (const m365Agent of accessService.getM365Agents()) {
    // `indexedChunks` is stamped by the index route; undefined means a
    // legacy record whose run predates the field — status 'indexed' is the
    // only signal there, so treat it as content-bearing.
    const hasIndexedContent = m365Agent.sources.some(
      (source) =>
        source.status === 'indexed' && (source.indexedChunks ?? 1) > 0,
    );
    if (!hasIndexedContent) continue;
    const { decision } = accessService.evaluateAccess({
      userMail,
      source: M365_AGENT_SOURCE,
      agentName: m365Agent.id,
    });
    if (decision !== 'deny') {
      entries.push({
        id: m365Agent.id,
        name: m365Agent.name,
        description: m365Agent.description,
        agentName: m365Agent.id,
        source: M365_AGENT_SOURCE,
        type: 'm365',
      });
    }
  }
  return entries;
}
/**
 * Admin-authored org RAG agents (serveable records only — enabled +
 * validation ok), filtered by the same layer-1 rules as the other
 * app-managed kinds. Carries the display metadata the static config file
 * would otherwise provide, plus the tool-toggle flags the client gates on.
 */
async function getVisibleOrgAgentEntries(
  userMail: string | undefined,
): Promise<DiscoveredAgent[]> {
  const accessService = AgentAccessService.getInstance();
  if (!accessService.isEnabled()) return [];
  const staticIds = new Set(getOrganizationAgents().map((agent) => agent.id));
  const entries: DiscoveredAgent[] = [];
  for (const orgAgent of await getServeableAdminOrgAgents()) {
    const { decision } = accessService.evaluateAccess({
      userMail,
      source: ORG_AGENT_SOURCE,
      agentName: orgAgent.id,
    });
    if (decision !== 'deny') {
      entries.push({
        id: orgAgent.id,
        name: orgAgent.name,
        description: orgAgent.description,
        agentName: orgAgent.id,
        source: ORG_AGENT_SOURCE,
        type: 'org',
        icon: orgAgent.icon,
        color: orgAgent.color,
        ...(orgAgent.category && { category: orgAgent.category }),
        ...(orgAgent.maintainedBy && { maintainedBy: orgAgent.maintainedBy }),
        allowWebSearch: orgAgent.allowWebSearch,
        allowCodeInterpreter: orgAgent.allowCodeInterpreter,
        overridesStatic: staticIds.has(orgAgent.id),
      });
    }
  }
  return entries;
}

/**
 * Static config agents the caller may not use, by the same layer-1 rule
 * lookup the invocation guard applies (`org-agent::<id>`). Folded into
 * `suppressedOrgAgentIds` so the bundled client list trims them — a UX
 * filter only; the chat pipeline re-evaluates on invocation. 'unavailable'
 * passes through like every other discovery surface.
 */
async function getDeniedStaticOrgAgentIds(
  userMail: string | undefined,
): Promise<string[]> {
  const accessService = AgentAccessService.getInstance();
  if (!accessService.isEnabled()) return [];
  await accessService.ensureFresh();
  return getOrganizationAgents()
    .filter(
      (agent) =>
        accessService.evaluateAccess({
          userMail,
          source: ORG_AGENT_SOURCE,
          agentName: agent.id,
        }).decision === 'deny',
    )
    .map((agent) => agent.id);
}

export interface AppAgents {
  agents: DiscoveredAgent[];
  /**
   * Static config ids that admin records currently override or disable,
   * plus the ones an access rule denies THIS user — the client trims the
   * bundled list with this, so a file agent can be retired, replaced or
   * restricted without a deploy.
   */
  suppressedOrgAgentIds: string[];
}

/**
 * The five lookups behind the fast half, in parallel. They evaluate
 * group-scoped rules synchronously from the group cache, so the caller
 * MUST have awaited `resolveUserGroupIds` first.
 */
export async function collectAppAgents(
  userMail: string | undefined,
): Promise<AppAgents> {
  const [
    promptAgentEntries,
    m365AgentEntries,
    orgAgentEntries,
    suppressedStaticIds,
    deniedStaticIds,
  ] = await Promise.all([
    getVisiblePromptAgentEntries(userMail),
    getVisibleM365AgentEntries(userMail),
    getVisibleOrgAgentEntries(userMail),
    getSuppressedStaticAgentIds(),
    getDeniedStaticOrgAgentIds(userMail),
  ]);
  return {
    agents: [...promptAgentEntries, ...m365AgentEntries, ...orgAgentEntries],
    suppressedOrgAgentIds: Array.from(
      new Set([...suppressedStaticIds, ...deniedStaticIds]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Foundry discovery (the slow half)
// ---------------------------------------------------------------------------

interface DiscoveryTokens {
  armToken: string;
  foundryToken: string | null;
}

interface DiscoveryOutcome {
  results: PromiseSettledResult<DiscoveredAgent[]>[];
}

/**
 * Acquires the user's ARM token via OBO (per-user RBAC filtering) and,
 * best-effort, a Foundry data-plane token — the two exchanges run in
 * parallel. Returns null when OBO fails in production: the app identity
 * has broader RBAC than any single user, so falling back would leak the
 * union of all agents to every user. In dev the app credential is used so
 * local setups without OBO can exercise discovery.
 */
async function acquireDiscoveryTokens(
  request: NextRequest,
  userLabel: string,
): Promise<DiscoveryTokens | null> {
  const isProd = process.env.NODE_ENV === 'production';
  try {
    const appAccessToken = await getAccessTokenForOBO(request);
    if (!appAccessToken) throw new Error('No OBO token');
    const tokenProvider = UserTokenProvider.getInstance();
    const [armToken, foundryToken] = await Promise.all([
      tokenProvider.getArmToken(appAccessToken),
      tokenProvider.getFoundryToken(appAccessToken).catch((enrichErr) => {
        console.warn(
          '[/api/agents] Foundry OBO unavailable, skipping data-plane enrichment:',
          enrichErr instanceof Error ? enrichErr.message : enrichErr,
        );
        return null;
      }),
    ]);
    return { armToken, foundryToken };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (isProd) {
      console.error(`[/api/agents] OBO failed for ${userLabel}: ${errMsg}`);
      return null;
    }
    console.warn(
      `[/api/agents] OBO failed (dev), using fallback credential: ${errMsg}`,
    );
    const credential = await createAppIdentityCredential();
    const [armResponse, foundryToken] = await Promise.all([
      credential.getToken('https://management.azure.com/.default'),
      credential
        .getToken('https://ai.azure.com/.default')
        .then((t) => t.token)
        .catch(() => null),
    ]);
    return { armToken: armResponse.token, foundryToken };
  }
}

/** Tokens → per-path discovery. Started before the group warm-up settles. */
async function startDiscovery(
  request: NextRequest,
  discoveryService: AgentDiscoveryService,
  allPaths: string[],
  cacheOwner: string,
): Promise<DiscoveryOutcome | null> {
  const tokens = await acquireDiscoveryTokens(request, cacheOwner);
  if (!tokens) return null;
  const results = await Promise.allSettled(
    allPaths.map(async (path) => {
      const agents = await discoveryService.listUserAgents(
        tokens.armToken,
        path,
        tokens.foundryToken,
        cacheOwner,
      );
      return agents.map((agent) => ({ ...agent, source: path }));
    }),
  );
  return { results };
}

export interface FoundryDiscovery {
  /** Access-filtered, endpoint-anchored Foundry agents. */
  agents: DiscoveredAgent[];
  /**
   * OBO failed in production: nothing could be discovered for this user.
   * Distinct from "discovered nothing" so the client can offer a retry.
   */
  unavailable: boolean;
}

/**
 * The slow half end to end: tokens → per-path discovery → merge → access
 * filter → endpoint trust anchors. `groupsReady` is awaited only before
 * the access filter, so discovery overlaps the Graph group warm-up.
 */
export async function discoverFoundryAgents(
  request: NextRequest,
  session: Session,
  allPaths: string[],
  groupsReady: Promise<unknown>,
  timing?: ServerTiming,
): Promise<FoundryDiscovery> {
  const discoveryService = AgentDiscoveryService.getInstance();
  const cacheOwner = cacheOwnerFor(session);
  if (request.nextUrl.searchParams.has('refresh')) {
    // THIS user's server-side cache only — one reload button must not
    // cold-start discovery for everyone on the replica.
    discoveryService.clearCacheForUser(cacheOwner);
  }

  const run = () =>
    startDiscovery(request, discoveryService, allPaths, cacheOwner);
  const discovery = timing ? await timing.time('discovery', run) : await run();
  if (!discovery) return { agents: [], unavailable: true };
  const { results } = discovery;

  // Collect all successful results, skip failures silently
  const allAgents: DiscoveredAgent[] = [];
  const seenAgentNames = new Set<string>();

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const agent of result.value) {
        // Guard against rare cases where the same source path is requested twice
        // through aliasing (e.g. same project added as both office + custom).
        // Within a single project, ARM already returns each agent once.
        const key = `${agent.source ?? 'default'}:${agent.agentName}`;
        if (!seenAgentNames.has(key)) {
          seenAgentNames.add(key);
          allAgents.push(agent);
        }
      }
    } else {
      console.warn(
        '[/api/agents] Failed to discover from source:',
        result.reason,
      );
    }
  }

  // App-layer access filter (docs/AGENT_ACCESS_CONTROL.md). Drops agents
  // the user fails evaluateAccess for — UX-level only; the invocation
  // guard in the chat pipeline is the security control. On 'unavailable'
  // (enabled + no last-known-good ruleset) discovery passes through
  // unfiltered: this is a visibility-only surface, and invocation fails
  // closed independently.
  let visibleAgents: DiscoveredAgent[] = allAgents;
  const accessService = AgentAccessService.getInstance();
  if (accessService.isEnabled()) {
    // Group-scoped rules read the group cache synchronously.
    await groupsReady;
    await (timing
      ? timing.time('rules', () => accessService.ensureFresh())
      : accessService.ensureFresh());
    const filtered: DiscoveredAgent[] = [];
    let rulesUnavailable = false;
    for (const agent of allAgents) {
      const { decision } = accessService.evaluateAccess({
        userMail: session.user.mail,
        source: agent.source,
        agentName: agent.agentName,
      });
      if (decision === 'unavailable') {
        rulesUnavailable = true;
        break;
      }
      if (decision === 'allow') {
        filtered.push(agent);
      }
    }
    if (rulesUnavailable) {
      console.error(
        '[/api/agents] Agent access rules unavailable; returning unfiltered discovery (invocation still fails closed)',
      );
    } else {
      visibleAgents = filtered;
    }
  }

  // Cache each discovered agent's endpoint for this specific user AND
  // source path. This is the trust anchor for the chat pipeline — the
  // user has just passed RBAC against ARM, so we know they're authorized
  // for these endpoints. The chat middleware reads from this cache
  // instead of trusting the request body's `foundryEndpoint` field.
  // Denied agents are excluded so their endpoints are never anchored.
  // Prompt agents are kept out of this loop entirely — they have no
  // Foundry endpoint and must never enter the trust-anchor cache.
  const userMail = session.user.mail;
  if (userMail) {
    for (const agent of visibleAgents) {
      discoveryService.cacheUserAgentEndpoint(
        userMail,
        agent.agentName,
        agent.source,
        agent.foundryEndpoint,
      );
    }
  }

  return { agents: visibleAgents, unavailable: false };
}
