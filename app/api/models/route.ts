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
 * ring-gated. When MODEL_DISCOVERY_ENABLED is on, the list is built from live
 * Azure AI Foundry deployment discovery joined to local metadata; otherwise (or
 * on any discovery failure) it falls back to the static config/models.json list
 * so chat never goes modelless. See docs/MODEL_DISCOVERY_DESIGN.md.
 *
 * Discovery runs under the APP identity (not per-user OBO) — deployed models are
 * region-uniform — so the result is cached per region by ModelDiscoveryService.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }

  // The static list, ring-gated — current behavior, and the graceful fallback.
  const staticModels = (): OpenAIModel[] =>
    applyRingGate(Object.values(OpenAIModels));

  if (!env.MODEL_DISCOVERY_ENABLED) {
    return successResponse({ models: staticModels(), source: 'static' });
  }

  try {
    const { regionalPath } = OfficeResolver.getDiscoveryPathsForUser(
      session.user.mail,
    );
    if (!regionalPath) {
      // Multi-region not configured — nothing to discover against.
      return successResponse({
        models: staticModels(),
        source: 'static-no-region',
      });
    }

    if (request.nextUrl.searchParams.has('refresh')) {
      ModelDiscoveryService.getInstance().clearCache();
    }

    // App identity → ARM token. Use DefaultAzureCredential, exactly as the rest
    // of the app's managed-identity Azure calls do (blob, RAG, search, Azure
    // OpenAI), so discovery authenticates as the same proven runtime identity
    // (env service principal in hosted envs, az-cli identity locally). The grant
    // target is whatever this resolves to — see MODEL_DISCOVERY_TODO.md.
    const credential = new DefaultAzureCredential();
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

    console.log(
      `[/api/models] Returning ${models.length} model(s) from discovery`,
    );
    return successResponse({ models, source: 'discovery' });
  } catch (error) {
    // Fail open: a discovery/RBAC/token error must not leave the user without
    // models. Mirror the agents route's graceful degradation.
    console.error(
      '[/api/models] Discovery failed, falling back to static list:',
      error instanceof Error ? error.message : error,
    );
    return successResponse({ models: staticModels(), source: 'fallback' });
  }
}
