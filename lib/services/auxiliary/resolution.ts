/** Pure candidate eligibility shared by runtime, admin, and readiness. */
import {
  applyTagOverlay,
  inferProvider,
  inferSdk,
  synthesizeUnknownModel,
} from '@/lib/services/models/modelResolution';

import {
  RETIREMENT_MOVE_DAYS,
  RETIREMENT_NOTICE_DAYS,
} from '@/lib/utils/shared/modelRetirement';

import { type OpenAIModel, OpenAIModels } from '@/types/openai';

import { isEuProcessing } from './bindings';
import { modelCapabilities } from './capabilities';
import {
  AUXILIARY_LIMITS,
  type AuxiliaryCandidate,
  type AuxiliaryCandidateStatus,
  type AuxiliaryInventory,
  type AuxiliaryObservation,
  type AuxiliaryReference,
  type AuxiliaryRegion,
  referenceKey,
} from './types';

/** Resolve underlying model capabilities, rather than trusting a mutable deployment alias. */
export function auxiliaryModel(
  deployment: AuxiliaryCandidate['deployment'],
): OpenAIModel {
  const known = Object.values(OpenAIModels).find(
    (model) => model.id === deployment.modelName,
  );
  const model = applyTagOverlay(
    known ?? synthesizeUnknownModel(deployment),
    deployment.tags,
  );
  return {
    ...model,
    id: deployment.modelName,
    deploymentName: deployment.deploymentName,
    provider: inferProvider(deployment.publisher),
    sdk: inferSdk(deployment.publisher),
  };
}

/** Stable compatibility identity; alias upgrades, SKU/account changes invalidate observations. */
export function candidateFingerprint(
  reference: AuxiliaryReference,
  inventory: AuxiliaryInventory,
  deployment: AuxiliaryCandidate['deployment'],
): string {
  return `${inventory.account.resourcePath}|${inventory.location ?? 'unknown'}|${reference.deploymentName}|${deployment.modelName}|${deployment.modelVersion ?? 'unknown'}|${deployment.sku ?? 'unknown'}`;
}

/** Evaluate a designated target. Unknown/expired residency evidence never becomes permission. */
export function resolveAuxiliaryCandidate(
  reference: AuxiliaryReference,
  inventory: AuxiliaryInventory | undefined,
  region: AuxiliaryRegion,
  observations: AuxiliaryObservation[] = [],
  now = Date.now(),
): { status: AuxiliaryCandidateStatus; candidate?: AuxiliaryCandidate } {
  const status: AuxiliaryCandidateStatus = {
    reference,
    eligible: false,
    retiringSoon: false,
    movingSoon: false,
    retirementUnknown: true,
    observations: [],
  };
  if (!inventory?.account.configured || !inventory.account.endpoint)
    return { status: { ...status, reason: 'endpoint_missing' } };
  if (
    !inventory.fetchedAt ||
    now - Date.parse(inventory.fetchedAt) >
      AUXILIARY_LIMITS.inventoryMaxAgeMs ||
    inventory.status === 'unavailable'
  )
    return { status: { ...status, reason: 'inventory_unavailable' } };
  const deployment = inventory.models.find(
    (model) => model.deploymentName === reference.deploymentName,
  );
  if (!deployment || deployment.provisioningState !== 'Succeeded')
    return { status: { ...status, deployment, reason: 'deployment_missing' } };
  const fingerprint = candidateFingerprint(reference, inventory, deployment);
  status.deployment = deployment;
  status.fingerprint = fingerprint;
  status.observations = observations.filter(
    (entry) =>
      entry.key === referenceKey(reference) &&
      entry.fingerprint === fingerprint,
  );
  status.retirementUnknown =
    !inventory.retirementAvailable ||
    (!deployment.retirementKnown && !deployment.retiresAt);
  const retirement = deployment.retiresAt
    ? Date.parse(deployment.retiresAt)
    : Infinity;
  status.retiringSoon = retirement - now <= RETIREMENT_NOTICE_DAYS * 86400_000;
  status.movingSoon = retirement - now <= RETIREMENT_MOVE_DAYS * 86400_000;
  if (retirement <= now) return { status: { ...status, reason: 'retired' } };
  if (region === 'EU' && !isEuProcessing(inventory.location, deployment.sku))
    return { status: { ...status, reason: 'residency' } };
  // OpenAI strict JSON schema; other compatible Foundry publishers use validated JSON-object mode.
  const model = auxiliaryModel(deployment);
  const publisher = (deployment.publisher ?? '').toLowerCase();
  if (
    ![
      'openai',
      'mistral',
      'mistral ai',
      'meta',
      'deepseek',
      'xai',
      'moonshot',
      'moonshotai',
    ].includes(publisher) ||
    deployment.capabilities.chatCompletion !== 'true' ||
    model.isAgent ||
    model.isDisabled
  )
    return { status: { ...status, reason: 'incompatible' } };
  status.eligible = true;
  status.capabilities = modelCapabilities(model);
  return {
    status,
    candidate: {
      reference,
      deployment,
      model,
      endpoint: inventory.account.endpoint,
      fingerprint,
      capabilityKnown: Object.values(OpenAIModels).some(
        (entry) => entry.id === deployment.modelName,
      ),
    },
  };
}
