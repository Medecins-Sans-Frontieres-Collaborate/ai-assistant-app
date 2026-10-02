import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { ModelDiscoveryService } from '@/lib/services/models/ModelDiscoveryService';
import {
  RegionalDeployments,
  applyRingGate,
  mergeMultiRegionDiscovery,
} from '@/lib/services/models/modelResolution';

import { UserRegion } from '@/lib/utils/shared/region';

import { ModelListSource, OpenAIModel, OpenAIModels } from '@/types/openai';

import { env } from '@/config/environment';
import { getCurrentEnvironment, getStaticModelList } from '@/config/models';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * The model list a region is served: live Foundry deployment discovery
 * joined to local metadata, region-tagged and ring-gated. Shared by
 * /api/models (which then filters it per user by usage limits) and by the
 * server-side consumers that need to pick a model the way the picker
 * would — the web search model, for one — so nothing names a deployment in
 * code that discovery and retirement handling already know about.
 *
 * Discovery runs under the APP identity (deployed models are region-uniform)
 * and is cached per account by ModelDiscoveryService. On any failure of the
 * home region this falls back to the vetted static list, so callers never
 * go modelless. See docs/MODEL_DISCOVERY_DESIGN.md.
 */

export interface ServedModels {
  models: OpenAIModel[];
  source: ModelListSource;
}

// The vetted static list (catalog minus beta/prod exclusions). Computed once
// at module scope: the catalog and ring are immutable at runtime.
const STATIC_MODELS: OpenAIModel[] = getStaticModelList();

// One DefaultAzureCredential for the process so its token cache survives
// across requests instead of being thrown away each call — built on first
// use, not at import: this module is reached from the chat route's import
// graph, and constructing a credential chain at load time is work (and
// noise in tests) for requests that never discover anything.
let credential: DefaultAzureCredential | null = null;
function getCredential(): DefaultAzureCredential {
  credential ??= new DefaultAzureCredential();
  return credential;
}

export async function discoverServedModels(
  region: UserRegion,
  opts?: { refresh?: boolean },
): Promise<ServedModels> {
  // Home region first — the merge is first-wins and the failure policy
  // below treats accounts[0] as load-bearing. US users also discover the EU
  // account (visibility only); EU users stay EU-only (data residency).
  const accounts = OfficeResolver.getModelDiscoveryAccountsForRegion(region);
  if (accounts.length === 0) {
    return { models: STATIC_MODELS, source: 'static-no-region' };
  }

  try {
    if (opts?.refresh) {
      // Bust every account this region discovers against (home + foreign),
      // but not other regions' entries (CLEARCACHE contract).
      for (const account of accounts) {
        ModelDiscoveryService.getInstance().clearCache(account.path);
      }
    }

    // App identity → ARM token, exactly as the rest of the app's
    // managed-identity Azure calls do. One token covers both accounts.
    const tokenResponse = await getCredential().getToken(
      'https://management.azure.com/.default',
    );
    if (!tokenResponse?.token) {
      throw new Error('No ARM token from app identity');
    }

    const results = await Promise.allSettled(
      accounts.map((account) =>
        ModelDiscoveryService.getInstance().listDeployedModels(
          tokenResponse.token,
          account.path,
        ),
      ),
    );

    // Asymmetric failure policy. The HOME region is load-bearing: without it
    // every model would fail the client's region gate and the list would be
    // effectively empty — worse than the static list, so rethrow into the
    // fallback. A FOREIGN region failing only costs visibility of its
    // exclusive models: drop it and say so via 'discovery-partial'.
    if (results[0].status === 'rejected') {
      throw results[0].reason;
    }
    const regional: RegionalDeployments[] = [];
    let partial = false;
    for (let i = 0; i < accounts.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        regional.push({ region: accounts[i].region, deployed: result.value });
      } else {
        partial = true;
        console.warn(
          `[servedModels] ${accounts[i].region} discovery failed; returning partial list:`,
          result.reason instanceof Error
            ? result.reason.message
            : result.reason,
        );
      }
    }

    const merged = mergeMultiRegionDiscovery(
      regional,
      OpenAIModels as Record<string, OpenAIModel>,
      {
        showUnknown: env.SHOW_MODELS_WITHOUT_METADATA,
        // Beta-first rollout: deployments tagged `ui-ring` are only served
        // to the rings the tag names (beta shares a Foundry with prod).
        ring: getCurrentEnvironment(),
      },
    );
    return {
      models: applyRingGate(merged),
      source: partial ? 'discovery-partial' : 'discovery',
    };
  } catch (error) {
    // Fail open: a discovery/RBAC/token error must not leave callers
    // without models.
    console.error(
      '[servedModels] Discovery failed, falling back to static list:',
      error instanceof Error ? error.message : error,
    );
    return { models: STATIC_MODELS, source: 'fallback' };
  }
}
