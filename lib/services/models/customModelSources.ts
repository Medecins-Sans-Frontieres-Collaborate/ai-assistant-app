/**
 * BYO custom model sources ("byom") — helpers for models discovered from a
 * Foundry account the USER added themselves and accesses with their own ARM
 * OBO credentials.
 *
 * These models deliberately bypass app-level curation and gating (isDisabled,
 * static exclusions, ring tags, LD flags): the user's own ARM RBAC on the
 * source account is the authorization. They render as plain standalone rows in
 * their own picker section, so every family/curation field is stripped.
 *
 * Id convention: `byom-${shortSourceHash(accountPath)}-${deploymentName}`.
 * The hash segment binds the id to the source account, letting the chat-time
 * resolver verify the client-supplied source path actually minted the id
 * before any ARM call is made with it.
 */
import { shortSourceHash } from '@/lib/utils/app/agentId';
import {
  isValidFoundryResourcePath,
  stripToAccountPath,
} from '@/lib/utils/shared/armPath';

import { OpenAIModel, OpenAIModels } from '@/types/openai';

import { DeployedModel, ModelDiscoveryService } from './ModelDiscoveryService';
import { applyTagOverlay, synthesizeUnknownModel } from './modelResolution';

import { createHash } from 'node:crypto';

/**
 * Curation/gating metadata that must NOT survive onto a byom model:
 * recommendation/tier/lifecycle/agent flags encode app policy that doesn't
 * apply to a user's own deployment. Family fields (seriesLabel, versionLabel,
 * variant*, defaultRank) are deliberately RETAINED so byom models get the
 * same family × variant hierarchy inside their source's section; `series`
 * itself is handled separately — namespaced per source so byom families never
 * merge with the catalog tree or another source. (`isDisabled` is also
 * handled separately — forced to false, not deleted, so the kill switch
 * visibly cannot apply.)
 */
const STRIPPED_CURATION_FIELDS = [
  'tier',
  'isRecommended',
  'lifecycle',
  'retirementDate',
  'retirementReplacement',
  'agentId',
  'isAgent',
  'hostedIn',
] as const satisfies readonly (keyof OpenAIModel)[];

/** Builds the byom model id for a deployment in a (stripped) account path. */
export function buildCustomSourceModelId(
  accountPath: string,
  deploymentName: string,
): string {
  return `byom-${shortSourceHash(accountPath)}-${deploymentName}`;
}

/**
 * Cache partition key for a user's ARM token. Full SHA-256 digest — a
 * collision would serve one user's RBAC-filtered deployment list to another
 * (same trust boundary as AgentDiscoveryService.hashKey).
 */
export function armTokenCacheScope(armToken: string): string {
  return createHash('sha256').update(armToken).digest('hex');
}

/**
 * Builds the OpenAIModel served for a deployment discovered from a custom
 * model source. Pure: joins local metadata by deployment name (falling back
 * to synthesis for unknown deployments), applies the ARM `ui-*` tag overlay,
 * then overrides identity/routing fields and strips app curation.
 *
 * `hosting` intentionally survives from metadata: it is a compliance
 * disclosure (e.g. claude-* inference runs on external infrastructure) that
 * stays true regardless of who owns the Foundry account.
 *
 * @param accountPath - The source's ARM ACCOUNT path (already stripped).
 * @param opts.location - The source account's Azure region (display only).
 */
export function buildCustomSourceModel(
  deployed: DeployedModel,
  accountPath: string,
  opts?: { location?: string },
): OpenAIModel {
  const meta = (OpenAIModels as Record<string, OpenAIModel>)[
    deployed.deploymentName
  ];
  // synthesizeUnknownModel already applies the tag overlay internally.
  const base = meta
    ? applyTagOverlay({ ...meta }, deployed.tags)
    : synthesizeUnknownModel(deployed);

  const model: OpenAIModel = {
    ...base,
    id: buildCustomSourceModelId(accountPath, deployed.deploymentName),
    modelSource: accountPath,
    isCustomSourceModel: true,
    deploymentName: deployed.deploymentName,
    // App kill switches don't govern the user's own deployment.
    isDisabled: false,
  };
  // Namespace the family per source: byom members of one account group into
  // ONE row within that source's section, but never merge with the catalog
  // tree or another source's models. Synthesized unknowns carry no series
  // and stay standalone rows.
  if (base.series) {
    model.series = `byom-${shortSourceHash(accountPath)}:${base.series}`;
  } else {
    delete model.series;
  }
  if (opts?.location !== undefined) model.sourceLocation = opts.location;
  if (deployed.modelVersion !== undefined) {
    model.deploymentModelVersion = deployed.modelVersion;
  }
  for (const field of STRIPPED_CURATION_FIELDS) {
    delete model[field];
  }
  return model;
}

// ARM api-version for reading the account resource itself (location lookup).
const ACCOUNT_API_VERSION = '2025-12-01';

// Account locations essentially never change, so a long TTL is safe; only
// successful lookups are cached so a transient ARM failure retries next time.
const LOCATION_CACHE_TTL_MS = 60 * 60 * 1000;
const accountLocationCache = new Map<
  string,
  { location: string; expiresAt: number }
>();

/** Test hook: resets the module-level account-location cache. */
export function clearAccountLocationCache(): void {
  accountLocationCache.clear();
}

/**
 * Best-effort lookup of a source account's Azure region (display only).
 * Never throws — any failure yields undefined so location enrichment can
 * never break model discovery for a source.
 *
 * @param accountPath - The source's ARM ACCOUNT path (already stripped).
 */
export async function getAccountLocation(
  armToken: string,
  accountPath: string,
): Promise<string | undefined> {
  // Origin discipline: the ARM URL is built from the validated path only, so
  // the bearer token can never be sent to a caller-controlled host.
  if (!isValidFoundryResourcePath(accountPath)) return undefined;

  const cached = accountLocationCache.get(accountPath);
  if (cached && Date.now() < cached.expiresAt) return cached.location;

  try {
    const response = await fetch(
      `https://management.azure.com${accountPath}?api-version=${ACCOUNT_API_VERSION}`,
      { headers: { Authorization: `Bearer ${armToken}` } },
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as { location?: unknown };
    if (typeof data.location !== 'string' || !data.location) return undefined;
    accountLocationCache.set(accountPath, {
      location: data.location,
      expiresAt: Date.now() + LOCATION_CACHE_TTL_MS,
    });
    return data.location;
  } catch {
    return undefined;
  }
}

/**
 * Chat-time resolution of a byom model id against the (validated) source path
 * the client sent alongside it. The server NEVER trusts the client's model
 * object — this re-derives the full config from live discovery under the
 * user's own ARM token, so RBAC + actual deployment existence are the
 * authorization.
 *
 * Returns null when the path is invalid, the id was not minted for this
 * account (hash integrity), or no such deployment exists. Discovery errors
 * (ARM 4xx/5xx, network) propagate to the caller, which fails closed.
 */
export async function resolveCustomSourceModel(
  userArmToken: string,
  modelId: string,
  modelSourcePath: string,
): Promise<OpenAIModel | null> {
  if (!isValidFoundryResourcePath(modelSourcePath)) return null;
  const accountPath = stripToAccountPath(modelSourcePath);
  // Re-validate post-strip: adversarial nested `/projects/x/projects/y` paths
  // survive stripping in a non-account shape and must be rejected here.
  if (!isValidFoundryResourcePath(accountPath)) return null;

  // Integrity: the id must have been minted for THIS account. Deployment
  // names may themselves contain dashes/dots, so the name is everything after
  // the fixed `byom-<hash>-` prefix rather than a dash-split segment.
  const idPrefix = `byom-${shortSourceHash(accountPath)}-`;
  if (!modelId.startsWith(idPrefix)) return null;
  const deploymentName = modelId.slice(idPrefix.length);
  if (!deploymentName) return null;

  const deployed = await ModelDiscoveryService.getInstance().listDeployedModels(
    userArmToken,
    accountPath,
    { cacheScope: armTokenCacheScope(userArmToken) },
  );
  const match = deployed.find((d) => d.deploymentName === deploymentName);
  if (!match) return null;

  return buildCustomSourceModel(match, accountPath);
}
