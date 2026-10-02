import { discoverServedModels } from '@/lib/services/models/servedModels';

import { versionRank } from '@/lib/utils/app/modelSeries';
import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';
import {
  getRetirementSignal,
  retirementFacts,
} from '@/lib/utils/shared/modelRetirement';
import { UserRegion } from '@/lib/utils/shared/region';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { env } from '@/config/environment';
import { getDefaultModel, getPolicyDefaultModel } from '@/config/models';

/**
 * Which deployment runs web searches (the Responses API `web_search` tool).
 *
 * Nothing is named in code: the model is picked from the list a region is
 * served — the same discovery and retirement rules the picker uses — so a
 * retiring search model moves on its own, 7 days before Azure stops it,
 * exactly like a user's conversation would. `WEB_SEARCH_RESPONSES_MODEL`
 * pins a deployment instead, for a deployment that wants one.
 */

const catalogMeta = (model: OpenAIModel): OpenAIModel =>
  OpenAIModels[model.id as OpenAIModelID] ?? model;

/**
 * The web-search model among `served`, or null when none qualifies. A
 * candidate is an OpenAI model on the Responses API (the only ones with the
 * `web_search` tool), usable from `region`, hosted there, and not leaving.
 * The policy default wins when it qualifies, then the dynamic default, then
 * the newest remaining candidate.
 */
export function pickWebSearchModel(
  served: OpenAIModel[],
  region: UserRegion,
  now: number,
): string | null {
  const servedIds = new Set(served.map((m) => m.id));
  const candidates = served.filter((m) => {
    const meta = catalogMeta(m);
    return (
      meta.provider === 'openai' &&
      meta.supportsResponsesApi === true &&
      !m.isDisabled &&
      isModelSelectableInRegion(m, region) &&
      (!m.hostedIn?.length || m.hostedIn.includes(region)) &&
      getRetirementSignal(retirementFacts(m, region), servedIds, now) === null
    );
  });
  if (candidates.length === 0) return null;
  const has = (id: string | undefined) =>
    id !== undefined && candidates.some((m) => m.id === id);

  const policyDefault = getPolicyDefaultModel(candidates, region);
  if (has(policyDefault)) return policyDefault as string;
  const dynamicDefault = getDefaultModel(candidates, region);
  if (has(dynamicDefault)) return dynamicDefault;
  return [...candidates].sort(
    (a, b) => versionRank(catalogMeta(b)) - versionRank(catalogMeta(a)),
  )[0].id;
}

// Discovery itself is cached for an hour per account; this only spares the
// ARM token round-trip and the merge on every search.
const RESOLVE_TTL_MS = 5 * 60 * 1000;
const resolved = new Map<UserRegion, { id: string; expiresAt: number }>();

/** Test seam. */
export function clearWebSearchModelCache(): void {
  resolved.clear();
}

/**
 * The deployment to run a web search on for `region`: the env pin when
 * set, else the pick from the served list, else the catalog default.
 */
export async function resolveWebSearchModel(
  region: UserRegion,
): Promise<string> {
  if (env.WEB_SEARCH_RESPONSES_MODEL) return env.WEB_SEARCH_RESPONSES_MODEL;

  const cached = resolved.get(region);
  if (cached && Date.now() < cached.expiresAt) return cached.id;

  const { models } = await discoverServedModels(region);
  const id =
    pickWebSearchModel(models, region, Date.now()) ??
    getDefaultModel(models, region);
  resolved.set(region, { id, expiresAt: Date.now() + RESOLVE_TTL_MS });
  return id;
}
