import { NextRequest } from 'next/server';

import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { ModelDiscoveryService } from '@/lib/services/models/ModelDiscoveryService';
import {
  applyRingGate,
  mergeDiscoveryWithMetadata,
} from '@/lib/services/models/modelResolution';

import {
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { OpenAIModel, OpenAIModels } from '@/types/openai';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * GET /api/models
 *
 * Returns the model list for the authenticated user, region-correct and
 * ring-gated. When NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED is on, the list is built
 * from live Azure AI Foundry deployment discovery joined to local metadata;
 * otherwise (or on any discovery failure) it falls back to the static
 * config/models.json list so chat never goes modelless. See
 * docs/MODEL_DISCOVERY_DESIGN.md.
 *
 * Discovery runs under the APP identity (not per-user OBO) — deployed models are
 * region-uniform — so the result is cached per region by ModelDiscoveryService.
 */

// The static list, ring-gated — current behavior, and the graceful fallback.
// Computed once at module scope: OpenAIModels and the ring gate are immutable at
// runtime, so there's no reason to rebuild this array per request.
const STATIC_MODELS: OpenAIModel[] = applyRingGate(Object.values(OpenAIModels));

// One DefaultAzureCredential for the process. Its per-instance token cache then
// survives across requests instead of being thrown away each call (C1).
const credential = new DefaultAzureCredential();

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }

  if (!env.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED) {
    return successResponse({ models: STATIC_MODELS, source: 'static' });
  }

  try {
    const { regionalPath } = OfficeResolver.getDiscoveryPathsForUser(
      session.user.mail,
    );
    if (!regionalPath) {
      // Multi-region not configured — nothing to discover against. Surface it so
      // ops can spot a user who has discovery on but no region mapping. Identify
      // by id (never email) to avoid logging PII.
      console.warn(
        `[/api/models] Discovery enabled but no regional path for user ${
          session.user.id ?? 'unknown'
        }; serving static list`,
      );
      return successResponse({
        models: STATIC_MODELS,
        source: 'static-no-region',
      });
    }

    if (request.nextUrl.searchParams.has('refresh')) {
      // Scope the bust to the caller's own region so one user's refresh doesn't
      // evict every region's cached discovery (CLEARCACHE contract).
      ModelDiscoveryService.getInstance().clearCache(regionalPath);
    }

    // App identity → ARM token. Use DefaultAzureCredential, exactly as the rest
    // of the app's managed-identity Azure calls do (blob, RAG, search, Azure
    // OpenAI), so discovery authenticates as the same proven runtime identity
    // (env service principal in hosted envs, az-cli identity locally). The grant
    // target is whatever this resolves to — see MODEL_DISCOVERY_TODO.md.
    const tokenResponse = await credential.getToken(
      'https://management.azure.com/.default',
    );
    if (!tokenResponse?.token) {
      throw new Error('No ARM token from app identity');
    }

    const deployed =
      await ModelDiscoveryService.getInstance().listDeployedModels(
        tokenResponse.token,
        regionalPath,
      );

    const merged = mergeDiscoveryWithMetadata(
      deployed,
      OpenAIModels as Record<string, OpenAIModel>,
      { showUnknown: env.SHOW_MODELS_WITHOUT_METADATA },
    );
    const models = applyRingGate(merged);

    if (env.NODE_ENV !== 'production') {
      console.log(
        `[/api/models] Returning ${models.length} model(s) from discovery`,
      );
    }
    return successResponse({ models, source: 'discovery' });
  } catch (error) {
    // Fail open: a discovery/RBAC/token error must not leave the user without
    // models. Mirror the agents route's graceful degradation.
    console.error(
      '[/api/models] Discovery failed, falling back to static list:',
      error instanceof Error ? error.message : error,
    );
    return successResponse({ models: STATIC_MODELS, source: 'fallback' });
  }
}
