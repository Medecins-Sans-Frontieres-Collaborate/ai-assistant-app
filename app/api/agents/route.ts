import { NextRequest, NextResponse } from 'next/server';

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
 * Optional query param `sources` — comma-separated ARM resource paths to
 * additional Foundry projects to discover agents from (user-configured).
 *
 * Returns empty array (not an error) if:
 * - Multi-region is not configured (no ARM resource paths)
 * - OBO token acquisition fails (graceful degradation)
 * - User has no agent access
 */
export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get ARM resource path for user's region
    const userRegion = session.user.region || 'EU';
    const defaultResourcePath = RegionResolver.getArmResourcePath(userRegion);

    // Parse optional custom source paths from query param
    const sourcesParam = request.nextUrl.searchParams.get('sources');
    const customSourcePaths = sourcesParam
      ? sourcesParam.split(',').filter(Boolean)
      : [];

    // Build list of all resource paths to query
    const allPaths = [defaultResourcePath, ...customSourcePaths].filter(
      (p): p is string => !!p,
    );

    if (allPaths.length === 0) {
      return NextResponse.json({ agents: [] });
    }

    // Clear server-side discovery cache on refresh
    if (request.nextUrl.searchParams.has('refresh')) {
      AgentDiscoveryService.getInstance().clearCache();
    }

    // Acquire ARM token — try OBO first (per-user RBAC), fall back to DefaultAzureCredential
    // OBO requires tenant admin consent which may not be granted. The fallback uses the
    // app's managed identity (deployed) or az login (localhost) — agents are still discovered,
    // just not RBAC-filtered per user.
    let armToken: string;

    try {
      const appAccessToken = await getAccessTokenForOBO(session);
      if (!appAccessToken) throw new Error('No OBO token');
      const tokenProvider = UserTokenProvider.getInstance();
      armToken = await tokenProvider.getArmToken(appAccessToken);
    } catch {
      // Fallback: use AzureCLICredential (az login) or ManagedIdentityCredential (deployed)
      // Skip EnvironmentCredential — it picks up the app registration which only has
      // RBAC on its own subscription, not on cross-subscription custom sources.
      const {
        ChainedTokenCredential,
        AzureCliCredential,
        ManagedIdentityCredential,
      } = await import('@azure/identity');
      const credential = new ChainedTokenCredential(
        new ManagedIdentityCredential(),
        new AzureCliCredential(),
      );
      const tokenResponse = await credential.getToken(
        'https://management.azure.com/.default',
      );
      armToken = tokenResponse.token;
    }

    // Discover agents from all sources in parallel
    const discoveryService = AgentDiscoveryService.getInstance();
    const results = await Promise.allSettled(
      allPaths.map(async (path) => {
        const agents = await discoveryService.listUserAgents(armToken, path);
        return agents.map((agent) => ({ ...agent, source: path }));
      }),
    );

    // Collect all successful results, skip failures silently
    const allAgents: DiscoveredAgent[] = [];
    const seenAgentNames = new Set<string>();

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const agent of result.value) {
          // Deduplicate by agentName across sources
          if (!seenAgentNames.has(agent.agentName)) {
            seenAgentNames.add(agent.agentName);
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

    return NextResponse.json({ agents: allAgents });
  } catch (error) {
    console.error('[/api/agents] Error discovering agents:', error);
    return NextResponse.json({ agents: [] });
  }
}
