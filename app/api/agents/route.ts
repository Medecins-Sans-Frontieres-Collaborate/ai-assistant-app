import { NextRequest, NextResponse } from 'next/server';

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

import { auth, getAccessTokenForOBO } from '@/auth';
import { getOrganizationAgents } from '@/lib/organizationAgents';

/**
 * GET /api/agents
 *
 * Discovers Foundry Agent Applications available to the authenticated user.
 * Uses the user's ARM-scoped OBO token so results are RBAC-filtered:
 * only agents the user has the Azure AI User role on are returned.
 *
 * Optional query param `sources` — comma-separated ARM resource paths to
 * additional Foundry projects to discover agents from (user-configured).
 *
 * Returns an empty Foundry list (not an error) if:
 * - Multi-region is not configured (no ARM resource paths)
 * - OBO token acquisition fails (graceful degradation)
 * - User has no agent access
 *
 * App-defined prompt agents (access-filtered) are served on EVERY response
 * path, including the two discovery skips above — they need neither ARM
 * discovery paths nor an OBO token.
 */

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
 */
async function getVisibleM365AgentEntries(
  userMail: string | undefined,
): Promise<DiscoveredAgent[]> {
  const accessService = AgentAccessService.getInstance();
  if (!accessService.isEnabled()) return [];
  await accessService.ensureFresh();
  const entries: DiscoveredAgent[] = [];
  for (const m365Agent of accessService.getM365Agents()) {
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

export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Office-scoped discovery returns three buckets:
    //   - regionalPath: global default for the user's region (always shown)
    //   - officePaths: extra paths for the user's office (e.g. MSF USA)
    //   - customSourcePaths: user's manually added connections
    const { regionalPath, officePaths } =
      OfficeResolver.getDiscoveryPathsForUser(session.user.mail);

    // Parse optional custom source paths from query param. Each must match
    // the strict Foundry ARM resource-path shape — invalid entries are dropped
    // (silently) to prevent path-injection / SSRF against management.azure.com.
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

    // Build a single deduplicated list of all paths to discover
    const orderedPaths = [
      ...(regionalPath ? [regionalPath] : []),
      ...officePaths,
      ...customSourcePaths,
    ];
    const allPaths = Array.from(new Set(orderedPaths));

    // Computed up front so every response path — including the discovery
    // early-returns below — serves the (access-filtered) prompt agents.
    const promptAgentEntries = await getVisiblePromptAgentEntries(
      session.user.mail,
    );
    const m365AgentEntries = await getVisibleM365AgentEntries(
      session.user.mail,
    );
    const orgAgentEntries = await getVisibleOrgAgentEntries(session.user.mail);
    // Static config ids that admin records currently override or disable —
    // the client trims the bundled list with this, so a file agent can be
    // retired or replaced without a deploy.
    const suppressedOrgAgentIds = await getSuppressedStaticAgentIds();

    if (allPaths.length === 0) {
      return NextResponse.json({
        agents: [
          ...promptAgentEntries,
          ...m365AgentEntries,
          ...orgAgentEntries,
        ],
        suppressedOrgAgentIds,
        regionalPath: null,
        officePaths: [],
      });
    }

    // Clear server-side discovery cache on refresh
    if (request.nextUrl.searchParams.has('refresh')) {
      AgentDiscoveryService.getInstance().clearCache();
    }

    // Acquire ARM token via OBO (per-user RBAC filtering).
    // In production, if OBO fails we return empty rather than falling back to
    // the app's identity — the app identity has broader RBAC than any single
    // user, so a silent fallback would leak the union of all agents to every
    // user. In dev, we allow fallback so local devs without OBO setup can
    // exercise the discovery path.
    const isProd = process.env.NODE_ENV === 'production';
    let armToken: string;
    let foundryToken: string | null = null;

    try {
      const appAccessToken = await getAccessTokenForOBO(request);
      if (!appAccessToken) throw new Error('No OBO token');
      const tokenProvider = UserTokenProvider.getInstance();
      armToken = await tokenProvider.getArmToken(appAccessToken);
      // Foundry token is used to enrich each Application with the data
      // plane agent's name + description. Best-effort: discovery still
      // works without it (returns ARM-only fields).
      try {
        foundryToken = await tokenProvider.getFoundryToken(appAccessToken);
      } catch (enrichErr) {
        console.warn(
          '[/api/agents] Foundry OBO unavailable, skipping data-plane enrichment:',
          enrichErr instanceof Error ? enrichErr.message : enrichErr,
        );
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (isProd) {
        console.error(
          `[/api/agents] OBO failed for ${session.user.mail ?? 'unknown'}: ${errMsg}`,
        );
        return NextResponse.json({
          agents: [
            ...promptAgentEntries,
            ...m365AgentEntries,
            ...orgAgentEntries,
          ],
          suppressedOrgAgentIds,
          regionalPath,
          officePaths,
        });
      }
      console.warn(
        `[/api/agents] OBO failed (dev), using fallback credential: ${errMsg}`,
      );
      const credential = await createAppIdentityCredential();
      const tokenResponse = await credential.getToken(
        'https://management.azure.com/.default',
      );
      armToken = tokenResponse.token;
      try {
        const fTok = await credential.getToken('https://ai.azure.com/.default');
        foundryToken = fTok.token;
      } catch {
        // Best-effort enrichment only.
      }
    }

    const discoveryService = AgentDiscoveryService.getInstance();
    const results = await Promise.allSettled(
      allPaths.map(async (path) => {
        const agents = await discoveryService.listUserAgents(
          armToken,
          path,
          foundryToken,
        );
        return agents.map((agent) => ({ ...agent, source: path }));
      }),
    );

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
      await accessService.ensureFresh();
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

    return NextResponse.json({
      agents: [
        ...visibleAgents,
        ...promptAgentEntries,
        ...m365AgentEntries,
        ...orgAgentEntries,
      ],
      suppressedOrgAgentIds,
      regionalPath,
      officePaths,
    });
  } catch (error) {
    console.error('[/api/agents] Error discovering agents:', error);
    return NextResponse.json({
      agents: [],
      suppressedOrgAgentIds: [],
      regionalPath: null,
      officePaths: [],
    });
  }
}
