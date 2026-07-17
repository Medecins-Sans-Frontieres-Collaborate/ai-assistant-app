import { NextRequest, NextResponse } from 'next/server';

import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';
import { createAppIdentityCredential } from '@/lib/services/auth/appIdentityCredential';
import { ModelDiscoveryService } from '@/lib/services/models/ModelDiscoveryService';
import {
  armTokenCacheScope,
  buildCustomSourceModel,
  getAccountLocation,
} from '@/lib/services/models/customModelSources';

import {
  isValidFoundryResourcePath,
  stripToAccountPath,
} from '@/lib/utils/shared/armPath';

import { OpenAIModel } from '@/types/openai';

import { auth, getAccessTokenForOBO } from '@/auth';

/**
 * GET /api/models/sources
 *
 * Discovers model deployments in the USER-added custom model sources ("BYO
 * models"). Runs under the user's own ARM OBO token so results are
 * RBAC-filtered: the user only sees deployments in accounts they actually
 * have access to — their RBAC IS the authorization, so app-level curation
 * and gating do not apply to these models (see customModelSources.ts).
 *
 * Query params:
 * - `sources` — comma-separated ARM resource paths (user-configured); each
 *   must pass the strict Foundry path validator or it is silently dropped.
 * - `refresh` — busts this user's scoped discovery cache for the given paths.
 *
 * Each source is additionally enriched with the account's Azure region
 * (`location`, best-effort — see getAccountLocation) for the Deployment
 * details display.
 *
 * Degradation (mirrors /api/agents): OBO failure in production returns an
 * empty success payload rather than falling back to the app identity (whose
 * broader RBAC would leak deployments the user can't access); dev falls back
 * to the app identity so local setups without OBO still work. Per-source
 * discovery failures degrade to `{ path, models: [], error }` without
 * breaking the other sources; the route never 500s for discovery failures.
 */

interface SourceDiscoveryResult {
  path: string;
  /** Azure region of the source account (display only; best-effort lookup). */
  location?: string;
  models: OpenAIModel[];
  error?: string;
}

export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Parse + validate the requested source paths. Each must match the strict
    // Foundry ARM resource-path shape — invalid entries are dropped (silently)
    // to prevent path-injection / SSRF against management.azure.com.
    const sourcesParam = request.nextUrl.searchParams.get('sources');
    const requestedSources = sourcesParam
      ? sourcesParam.split(',').filter(Boolean)
      : [];
    const validSources = requestedSources.filter((p) =>
      isValidFoundryResourcePath(p),
    );
    if (validSources.length !== requestedSources.length) {
      console.warn(
        `[/api/models/sources] Dropped ${requestedSources.length - validSources.length} invalid source path(s)`,
      );
    }
    const sourcePaths = Array.from(new Set(validSources));

    if (sourcePaths.length === 0) {
      return NextResponse.json({ sources: [] });
    }

    // Acquire an ARM token via OBO (per-user RBAC filtering). In production,
    // if OBO fails we return empty rather than falling back to the app's
    // identity — its RBAC is broader than any single user's, so a silent
    // fallback would leak deployments across trust boundaries. In dev, we
    // allow fallback so local devs without OBO setup can exercise the path.
    const isProd = process.env.NODE_ENV === 'production';
    let armToken: string;

    try {
      const appAccessToken = await getAccessTokenForOBO(request);
      if (!appAccessToken) throw new Error('No OBO token');
      armToken =
        await UserTokenProvider.getInstance().getArmToken(appAccessToken);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (isProd) {
        // Identify by id (never email) to avoid logging PII.
        console.error(
          `[/api/models/sources] OBO failed for user ${session.user.id ?? 'unknown'}: ${errMsg}`,
        );
        return NextResponse.json({ sources: [] });
      }
      console.warn(
        `[/api/models/sources] OBO failed (dev), using fallback credential: ${errMsg}`,
      );
      const credential = await createAppIdentityCredential();
      const tokenResponse = await credential.getToken(
        'https://management.azure.com/.default',
      );
      if (!tokenResponse?.token) {
        throw new Error('No ARM token from fallback credential');
      }
      armToken = tokenResponse.token;
    }

    // Per-user cache partition: user tokens carry user RBAC, so their results
    // must never be served from (or into) the app-identity cache entries.
    const cacheScope = armTokenCacheScope(armToken);
    const discovery = ModelDiscoveryService.getInstance();

    if (request.nextUrl.searchParams.has('refresh')) {
      // Bust only this user's scoped entries for the requested paths — other
      // users' (and the app identity's) cached discovery stays intact.
      for (const path of sourcePaths) {
        discovery.clearCache(path, cacheScope);
      }
    }

    const results = await Promise.allSettled(
      sourcePaths.map(async (path) => {
        const accountPath = stripToAccountPath(path);
        // Location enrichment is best-effort (getAccountLocation never
        // throws): a failed lookup yields undefined, never a failed source.
        const [deployed, location] = await Promise.all([
          discovery.listDeployedModels(armToken, path, { cacheScope }),
          getAccountLocation(armToken, accountPath),
        ]);
        return {
          location,
          models: deployed.map((d) =>
            buildCustomSourceModel(d, accountPath, { location }),
          ),
        };
      }),
    );

    const sources: SourceDiscoveryResult[] = results.map((result, i) => {
      if (result.status === 'fulfilled') {
        return {
          path: sourcePaths[i],
          location: result.value.location,
          models: result.value.models,
        };
      }
      console.warn(
        '[/api/models/sources] Discovery failed for source:',
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
      return { path: sourcePaths[i], models: [], error: 'discovery_failed' };
    });

    return NextResponse.json({ sources });
  } catch (error) {
    // Never 500 for discovery-shaped failures — the picker degrades to
    // "no custom-source models" instead of erroring the whole Models tab.
    console.error(
      '[/api/models/sources] Error discovering model sources:',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ sources: [] });
  }
}
