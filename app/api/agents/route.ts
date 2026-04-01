import { NextResponse } from 'next/server';

import {
  AgentDiscoveryService,
  DiscoveredAgent,
} from '@/lib/services/agents/AgentDiscoveryService';
import { RegionResolver } from '@/lib/services/auth/RegionResolver';
import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';

import { auth, getAccessTokenForOBO } from '@/auth';

/**
 * GET /api/agents
 *
 * Discovers Foundry Agent Applications available to the authenticated user.
 * Uses the user's ARM-scoped OBO token so results are RBAC-filtered:
 * only agents the user has the Azure AI User role on are returned.
 *
 * Returns empty array (not an error) if:
 * - Multi-region is not configured (no ARM resource paths)
 * - OBO token acquisition fails (graceful degradation)
 * - User has no agent access
 */
export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get ARM resource path for user's region
    const userRegion = session.user.region || 'EU';
    const resourcePath = RegionResolver.getArmResourcePath(userRegion);

    if (!resourcePath) {
      // Multi-region not configured — return empty agent list
      // Frontend will still show static RAG agents from organization-agents.json
      return NextResponse.json({ agents: [] });
    }

    // Acquire OBO token for ARM API
    const appAccessToken = await getAccessTokenForOBO(session);
    if (!appAccessToken) {
      console.warn('[/api/agents] Could not acquire app access token for OBO');
      return NextResponse.json({ agents: [] });
    }

    const tokenProvider = UserTokenProvider.getInstance();
    const armToken = await tokenProvider.getArmToken(appAccessToken);

    // Discover agents
    const discoveryService = AgentDiscoveryService.getInstance();
    const agents: DiscoveredAgent[] = await discoveryService.listUserAgents(
      armToken,
      resourcePath,
    );

    return NextResponse.json({ agents });
  } catch (error) {
    console.error('[/api/agents] Error discovering agents:', error);
    // Return empty array — don't break the frontend
    return NextResponse.json({ agents: [] });
  }
}
