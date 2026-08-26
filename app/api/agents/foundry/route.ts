import { NextRequest, NextResponse } from 'next/server';

import {
  ServerTiming,
  discoverFoundryAgents,
  resolveDiscoveryPaths,
} from '@/lib/services/agents/agentDiscoveryRoute';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { auth } from '@/auth';

/**
 * GET /api/agents/foundry — the SLOW half of agent discovery
 * (docs/AGENTS_DISCOVERY_SPLIT_PLAN.md): OBO (ARM ∥ Foundry) → per-project
 * ARM listing + data-plane enrichment → access filter → endpoint trust
 * anchors. Results are RBAC-filtered because the user's own ARM token is
 * used. Query params: `sources` (custom resource paths), `refresh` (clears
 * THIS user's server cache first).
 *
 * `unavailable: true` means nothing could be discovered for this user
 * (OBO failed in production, or an unexpected error) — the client shows a
 * retry line, not "no agents".
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const timing = new ServerTiming();
  const groupsWarmup = timing.time('groups', () =>
    resolveUserGroupIds(request, session),
  );
  const { regionalPath, officePaths, allPaths } = resolveDiscoveryPaths(
    request,
    session.user.mail,
  );
  if (allPaths.length === 0) {
    await groupsWarmup;
    return NextResponse.json(
      { agents: [], regionalPath: null, officePaths: [], unavailable: false },
      { headers: { 'Server-Timing': timing.header() } },
    );
  }

  try {
    const discovery = await discoverFoundryAgents(
      request,
      session,
      allPaths,
      groupsWarmup,
      timing,
    );
    return NextResponse.json(
      {
        agents: discovery.agents,
        regionalPath,
        officePaths,
        unavailable: discovery.unavailable,
      },
      { headers: { 'Server-Timing': timing.header() } },
    );
  } catch (error) {
    console.error('[/api/agents/foundry] Error discovering agents:', error);
    return NextResponse.json(
      { agents: [], regionalPath, officePaths, unavailable: true },
      { headers: { 'Server-Timing': timing.header() } },
    );
  }
}
