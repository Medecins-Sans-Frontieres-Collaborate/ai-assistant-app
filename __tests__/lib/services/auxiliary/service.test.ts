/** Real policy/inventory/executor integration with only ARM, credential and blob seams mocked. */
import { AuxiliaryModelService } from '@/lib/services/auxiliary/AuxiliaryModelService';
import { AuxiliaryPolicySchema } from '@/lib/services/auxiliary/types';

import { auxiliaryReport } from './fixtures';

import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPolicy: vi.fn(),
  readState: vi.fn(),
  persist: vi.fn(),
  claim: vi.fn(),
  observe: vi.fn(),
  token: vi.fn(),
  create: vi.fn(),
}));
const config = vi.hoisted(() => ({
  NODE_ENV: 'test',
  NEXT_PUBLIC_ENV: 'live',
  AZURE_AI_FOUNDRY_ENDPOINT_EU:
    'https://eu.services.ai.azure.com/api/projects/default',
  AZURE_AI_FOUNDRY_ENDPOINT_US:
    'https://us.services.ai.azure.com/api/projects/default',
  AZURE_AI_FOUNDRY_ENDPOINT:
    'https://us.services.ai.azure.com/api/projects/default',
  AZURE_AI_FOUNDRY_RESOURCE_ID_EU:
    '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/eu',
  AZURE_AI_FOUNDRY_RESOURCE_ID_US:
    '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/us',
}));
vi.mock('@/config/environment', () => ({ env: config }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken = mocks.token;
  },
}));
vi.mock('@/lib/services/auxiliary/store', () => ({
  readAuxiliaryPolicy: mocks.readPolicy,
  readAuxiliaryState: mocks.readState,
  persistAuxiliaryState: mocks.persist,
  claimAuxiliaryProbe: mocks.claim,
}));
vi.mock('@/lib/services/models/ModelDiscoveryService', () => ({
  ModelDiscoveryService: {
    getInstance: () => ({ observeDeployments: mocks.observe }),
  },
}));
let service: AuxiliaryModelService;
const reportFixture = () => auxiliaryReport();
let fixture: ReturnType<typeof reportFixture>;

function valueFor(schema: any): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        valueFor(value),
      ]),
    );
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  return '';
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture = reportFixture();
  mocks.readPolicy.mockResolvedValue({
    policy: AuxiliaryPolicySchema.parse({
      version: 1,
      environment: 'live',
      assignments: fixture.effective,
      updatedBy: 'admin@example.com',
      updatedAt: new Date().toISOString(),
    }),
    etag: '"r1"',
  });
  mocks.readState.mockResolvedValue({ observations: [], history: [] });
  mocks.persist.mockResolvedValue(undefined);
  mocks.claim.mockResolvedValue(true);
  mocks.token.mockResolvedValue({ token: 'app-token' });
  mocks.observe.mockImplementation(async (_token, path) => {
    const inventory = fixture.inventory.find(
      (entry) => entry.account.resourcePath === path,
    )!;
    const { account: _, ...observation } = inventory;
    return observation;
  });
  mocks.create.mockImplementation(async (params) => ({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify(
            params.response_format?.json_schema
              ? valueFor(params.response_format.json_schema.schema)
              : { ok: true },
          ),
        },
      },
    ],
  }));
  service = new AuxiliaryModelService(
    () =>
      ({
        chat: { completions: { create: mocks.create } },
      }) as unknown as OpenAI,
  );
});
afterEach(() => {
  service.dispose();
  vi.useRealTimers();
});

describe('environment-local model service', () => {
  it('observes inventory without calling the inference provider', async () => {
    const report = await service.report();
    expect(report.environment).toBe('live');
    expect(report.chains[0].state).toBe('unverified');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.observe).toHaveBeenCalledWith(
      'app-token',
      config.AZURE_AI_FOUNDRY_RESOURCE_ID_EU,
      false,
    );
  });
  it('resolves custom deployment aliases against actual model capabilities', async () => {
    const result = await service.resolve('skills', 'EU');
    expect(
      result.candidates.map((entry) => entry.reference.deploymentName),
    ).toEqual(['classifier']);
    expect(result.candidates[0].model.id).toBe('gpt-5.4-mini');
  });
  it('never resolves a US global deployment as an EU fallback', async () => {
    const policy = await mocks.readPolicy();
    policy.policy.assignments.routing.EU = [
      { accountBinding: 'US', deploymentName: 'classifier' },
    ];
    expect((await service.resolve('skills', 'EU')).candidates).toEqual([]);
  });
  it('runs every real routing schema through app clients, then reports readiness', async () => {
    const report = await service.probe(
      { accountBinding: 'EU', deploymentName: 'classifier' },
      'routing',
      'EU',
    );
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(
      mocks.create.mock.calls.map(
        ([request]) => request.response_format.json_schema.name,
      ),
    ).toEqual([
      'skill_selection',
      'tool_router_response',
      'document_trim_classification',
    ]);
    expect(
      report.chains.find(
        (chain) => chain.purpose === 'routing' && chain.region === 'EU',
      )?.state,
    ).toBe('ready');
    expect(mocks.persist).toHaveBeenCalled();
  });
  it('permits probing an eligible new GPT deployment before it is designated', async () => {
    fixture.inventory[0].models.push({
      ...fixture.inventory[0].models[0],
      deploymentName: 'new-gpt',
      modelName: 'gpt-6-small-new',
    });
    const report = await service.probe(
      { accountBinding: 'EU', deploymentName: 'new-gpt' },
      'routing',
      'EU',
    );
    const newChoice = report.choices.EU.find(
      (entry) => entry.reference.deploymentName === 'new-gpt',
    );
    expect(
      newChoice?.observations.filter((entry) => entry.success),
    ).toHaveLength(3);
    expect(
      report.effective.routing.EU.map((entry) => entry.deploymentName),
    ).not.toContain('new-gpt');
  });
  it('refuses paid checks when the cross-replica probe claim is already held', async () => {
    mocks.claim.mockResolvedValue(false);
    await expect(
      service.probe(
        { accountBinding: 'EU', deploymentName: 'classifier' },
        'routing',
        'EU',
      ),
    ).rejects.toThrow('PROBE_RATE_LIMIT');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('refuses a changed/global SKU before running any compatibility probe', async () => {
    fixture.inventory[0].models[0].sku = 'GlobalStandard';
    await expect(
      service.probe(
        { accountBinding: 'EU', deploymentName: 'classifier' },
        'routing',
        'EU',
      ),
    ).rejects.toThrow('Probe target ineligible: residency');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('preserves safe bounded policy during outages, then stops using it when expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await service.report();
    mocks.readPolicy.mockRejectedValue(new Error('storage unavailable'));
    vi.setSystemTime(Date.now() + 61_000);
    expect((await service.report(true)).effective.routing.EU).toEqual(
      fixture.effective.routing.EU,
    );
    vi.setSystemTime(Date.now() + 3600_001);
    expect((await service.report(true)).effective.routing.EU).toEqual([]);
  });
  it('does not treat inventory credential failure as an authoritative empty account', async () => {
    await service.report();
    mocks.token.mockRejectedValue(new Error('credential unavailable'));
    const report = await service.report(true);
    expect(report.inventory[0].status).toBe('stale');
    expect(report.inventory[0].models).toEqual(fixture.inventory[0].models);
  });
});
