/** Small shared auxiliary fixtures with asserted regional identities and real eligibility. */
import { resolveAuxiliaryCandidate } from '@/lib/services/auxiliary/resolution';
import type {
  AuxiliaryAdminReport,
  AuxiliaryAssignments,
  AuxiliaryInventory,
} from '@/lib/services/auxiliary/types';

/** Produce a current EU-data-zone/US-global report with one deployment per purpose and region. */
export function auxiliaryReport(): AuxiliaryAdminReport {
  const now = new Date().toISOString();
  const inventories: AuxiliaryInventory[] = (['EU', 'US'] as const).map(
    (binding) => ({
      account: {
        binding,
        configured: true,
        endpoint: `https://${binding.toLowerCase()}.services.ai.azure.com/openai/v1/`,
        resourcePath: `/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/${binding.toLowerCase()}`,
      },
      status: 'current',
      fetchedAt: now,
      location: binding === 'EU' ? 'swedencentral' : 'eastus2',
      retirementAvailable: true,
      models: [
        {
          deploymentName: 'classifier',
          modelName: 'gpt-5.4-mini',
          modelVersion: 'v1',
          publisher: 'OpenAI',
          sku: binding === 'EU' ? 'DataZoneStandard' : 'GlobalStandard',
          capabilities: { chatCompletion: 'true' },
          provisioningState: 'Succeeded',
          tags: {},
        },
      ],
    }),
  );
  const regional = {
    EU: [{ accountBinding: 'EU' as const, deploymentName: 'classifier' }],
    US: [{ accountBinding: 'US' as const, deploymentName: 'classifier' }],
  };
  const assignments: AuxiliaryAssignments = {
    routing: structuredClone(regional),
    searchAssessment: structuredClone(regional),
  };
  const choices = {
    EU: inventories.map(
      (entry) =>
        resolveAuxiliaryCandidate(
          {
            accountBinding: entry.account.binding,
            deploymentName: 'classifier',
          },
          entry,
          'EU',
        ).status,
    ),
    US: inventories.map(
      (entry) =>
        resolveAuxiliaryCandidate(
          {
            accountBinding: entry.account.binding,
            deploymentName: 'classifier',
          },
          entry,
          'US',
        ).status,
    ),
  };
  return {
    environment: 'live',
    policy: null,
    etag: null,
    configUnavailable: false,
    defaults: assignments,
    effective: assignments,
    revision: 'bootstrap:test',
    checkedAt: now,
    inventory: inventories,
    observations: [],
    incidents: [],
    choices,
    history: [],
    chains: (['routing', 'searchAssessment'] as const).flatMap((purpose) =>
      (['EU', 'US'] as const).map((region) => ({
        purpose,
        region,
        state: 'unverified',
        redundancy: 1,
        candidates: [
          choices[region].find(
            (entry) => entry.reference.accountBinding === region,
          )!,
        ],
      })),
    ),
  };
}
