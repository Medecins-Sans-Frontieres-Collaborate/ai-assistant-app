import { NextRequest, NextResponse } from 'next/server';

import {
  ServerTiming,
  collectAppAgents,
  discoverFoundryAgents,
  resolveDiscoveryPaths,
} from '@/lib/services/agents/agentDiscoveryRoute';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { auth } from '@/auth';

/**
 * GET /api/agents — the FAST half of agent discovery
 * (docs/AGENTS_DISCOVERY_SPLIT_PLAN.md): app-defined agents the caller may
 * see (prompt, Microsoft 365, knowledge) plus the static config ids to
 * suppress. Tens of milliseconds; no Foundry, no OBO. Foundry agents come
 * from GET /api/agents/foundry.
 *
 * `?include=foundry` returns the legacy combined payload (both halves in
 * one response) for clients that have not moved to the split yet. Remove
 * one release after the client change ships.
 *
 * Errors: the fast half answers 503 so the client retries and shows an
 * error state rather than a false "no agents"; the legacy switch keeps
 * the old degrade-to-empty contract.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const timing = new ServerTiming();
  // Group-membership warm-up MUST precede every evaluateAccess below —
  // group-scoped rules read the cache synchronously. Never throws.
  const groupsWarmup = timing.time('groups', () =>
    resolveUserGroupIds(request, session),
  );
  const includeFoundry =
    request.nextUrl.searchParams.get('include') === 'foundry';

  if (!includeFoundry) {
    try {
      await groupsWarmup;
      const app = await timing.time('lookups', () =>
        collectAppAgents(session.user.mail),
      );
      return NextResponse.json(
        {
          agents: app.agents,
          suppressedOrgAgentIds: app.suppressedOrgAgentIds,
          regionalPath: null,
          officePaths: [],
        },
        { headers: { 'Server-Timing': timing.header() } },
      );
    } catch (error) {
      console.error('[/api/agents] Error listing app agents:', error);
      return NextResponse.json(
        { error: 'Agents are temporarily unavailable' },
        { status: 503, headers: { 'Server-Timing': timing.header() } },
      );
    }
  }

  // Legacy combined payload.
  try {
    const { regionalPath, officePaths, allPaths } = resolveDiscoveryPaths(
      request,
      session.user.mail,
    );
    // Discovery only needs tokens, so it starts before the group warm-up
    // resolves; the lookups evaluate group-scoped rules and wait for it.
    const discoveryPromise =
      allPaths.length > 0
        ? discoverFoundryAgents(
            request,
            session,
            allPaths,
            groupsWarmup,
            timing,
          )
        : Promise.resolve({ agents: [], unavailable: false });
    await groupsWarmup;
    const [app, discovery] = await Promise.all([
      timing.time('lookups', () => collectAppAgents(session.user.mail)),
      discoveryPromise,
    ]);
    return NextResponse.json(
      {
        agents: [...discovery.agents, ...app.agents],
        suppressedOrgAgentIds: app.suppressedOrgAgentIds,
        regionalPath: allPaths.length > 0 ? regionalPath : null,
        officePaths: allPaths.length > 0 ? officePaths : [],
      },
      { headers: { 'Server-Timing': timing.header() } },
    );
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
