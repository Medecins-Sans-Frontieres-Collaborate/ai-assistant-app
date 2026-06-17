import { NextRequest, NextResponse } from 'next/server';

import {
  AgentDiscoveryService,
  DiscoveredAgent,
} from '@/lib/services/agents/AgentDiscoveryService';
import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';
import { createAppIdentityCredential } from '@/lib/services/auth/appIdentityCredential';

import { isValidFoundryResourcePath } from '@/lib/utils/shared/armPath';

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

    if (allPaths.length === 0) {
      return NextResponse.json({
        agents: [],
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
          agents: [],
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

    // Cache each discovered agent's endpoint for this specific user AND
    // source path. This is the trust anchor for the chat pipeline — the
    // user has just passed RBAC against ARM, so we know they're authorized
    // for these endpoints. The chat middleware reads from this cache
    // instead of trusting the request body's `foundryEndpoint` field.
    const userMail = session.user.mail;
    if (userMail) {
      for (const agent of allAgents) {
        discoveryService.cacheUserAgentEndpoint(
          userMail,
          agent.agentName,
          agent.source,
          agent.foundryEndpoint,
        );
      }
    }

    return NextResponse.json({
      agents: allAgents,
      regionalPath,
      officePaths,
    });
  } catch (error) {
    console.error('[/api/agents] Error discovering agents:', error);
    return NextResponse.json({
      agents: [],
      regionalPath: null,
      officePaths: [],
    });
  }
}
