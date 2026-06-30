import { ModelDiscoveryService } from '@/lib/services/models/ModelDiscoveryService';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Captured verbatim from scripts/discover-foundry-models.mjs against the live EU
// account (ts-aiassist-live-eu). Exercises the real shapes the service must
// handle: deployment-name vs underlying-model-name divergence (gpt-5.2 runs
// model gpt-5.5), non-chat deployments (whisper, embeddings), and an
// unknown-to-our-app chat model (Mistral-Large-3).

const ACCOUNT_PATH =
  '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/ts-aiassist-live-eu';
const PROJECT_PATH = `${ACCOUNT_PATH}/projects/default`;
const ARM_TOKEN = 'arm-token';

function dep(
  name: string,
  format: string,
  modelName: string,
  version: string,
  capabilities: Record<string, string>,
  provisioningState = 'Succeeded',
) {
  return {
    name,
    sku: { name: 'DataZoneStandard', capacity: 250 },
    properties: {
      model: { format, name: modelName, version },
      provisioningState,
      capabilities,
    },
  };
}

const EU_DEPLOYMENTS = [
  dep(
    'Llama-4-Maverick-17B-128E-Instruct-FP8',
    'Meta',
    'Llama-4-Maverick-17B-128E-Instruct-FP8',
    '1',
    { chatCompletion: 'true', agentsV2: 'true' },
  ),
  dep('DeepSeek-R1', 'DeepSeek', 'DeepSeek-R1', '1', {
    chatCompletion: 'true',
  }),
  dep('o3', 'OpenAI', 'o3', '2025-04-16', {
    chatCompletion: 'true',
    responses: 'true',
  }),
  dep('gpt-5-mini', 'OpenAI', 'gpt-5-mini', '2025-08-07', {
    chatCompletion: 'true',
  }),
  dep('gpt-4.1', 'OpenAI', 'gpt-4.1', '2025-04-14', { chatCompletion: 'true' }),
  dep('DeepSeek-V3.1', 'DeepSeek', 'DeepSeek-V3.1', '1', {
    chatCompletion: 'true',
  }),
  dep('whisper', 'OpenAI', 'whisper', '001', {
    audio: 'true',
    audioTranscriptions: 'true',
  }),
  // Deployment name diverges from the underlying model (gpt-5.5):
  dep('gpt-5.2-chat', 'OpenAI', 'gpt-5.5', '2026-04-24', {
    chatCompletion: 'true',
  }),
  dep('gpt-5.2', 'OpenAI', 'gpt-5.5', '2026-04-24', { chatCompletion: 'true' }),
  dep('text-embedding-3-small', 'OpenAI', 'text-embedding-3-small', '1', {
    embeddings: 'true',
  }),
  dep('Mistral-Large-3', 'Mistral AI', 'Mistral-Large-3', '1', {
    chatCompletion: 'true',
  }),
];

function mockArm(deployments: unknown[], pages?: unknown[][]) {
  // If `pages` given, serve multi-page with nextLink; else a single page.
  if (pages) {
    let i = 0;
    global.fetch = vi.fn(async () => {
      const value = pages[i];
      const nextLink =
        i < pages.length - 1
          ? `https://management.azure.com/next?page=${i + 1}`
          : undefined;
      i++;
      return {
        ok: true,
        json: async () => ({ value, nextLink }),
      } as Response;
    }) as unknown as typeof fetch;
    return;
  }
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ value: deployments }),
  })) as unknown as typeof fetch;
}

describe('ModelDiscoveryService', () => {
  let service: ModelDiscoveryService;

  beforeEach(() => {
    service = ModelDiscoveryService.getInstance();
    service.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns only chat-capable, succeeded deployments (drops whisper + embeddings)', async () => {
    mockArm(EU_DEPLOYMENTS);
    const models = await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);

    const names = models.map((m) => m.deploymentName).sort();
    expect(names).toEqual(
      [
        'DeepSeek-R1',
        'DeepSeek-V3.1',
        'Llama-4-Maverick-17B-128E-Instruct-FP8',
        'Mistral-Large-3',
        'gpt-4.1',
        'gpt-5-mini',
        'gpt-5.2',
        'gpt-5.2-chat',
        'o3',
      ].sort(),
    );
    expect(names).not.toContain('whisper');
    expect(names).not.toContain('text-embedding-3-small');
  });

  it('joins on deployment name, preserving the divergent underlying model name', async () => {
    mockArm(EU_DEPLOYMENTS);
    const models = await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);

    const chat = models.find((m) => m.deploymentName === 'gpt-5.2-chat');
    expect(chat).toBeDefined();
    expect(chat?.modelName).toBe('gpt-5.5');
    expect(chat?.modelVersion).toBe('2026-04-24');
    expect(chat?.publisher).toBe('OpenAI');
  });

  it('surfaces deployed-but-unknown chat models (Mistral-Large-3)', async () => {
    mockArm(EU_DEPLOYMENTS);
    const models = await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);
    expect(models.map((m) => m.deploymentName)).toContain('Mistral-Large-3');
  });

  it('does NOT surface claude-* / grok-3 (not deployed in EU — the drift fix)', async () => {
    mockArm(EU_DEPLOYMENTS);
    const models = await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);
    const names = models.map((m) => m.deploymentName);
    for (const missing of [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'grok-3',
    ]) {
      expect(names).not.toContain(missing);
    }
  });

  it('strips /projects/<name> and queries the ACCOUNT-scoped ARM path', async () => {
    mockArm(EU_DEPLOYMENTS);
    await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);
    const calledUrl = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledUrl).toContain(`${ACCOUNT_PATH}/deployments`);
    expect(calledUrl).not.toContain('/projects/');
    expect(calledUrl).toContain('api-version=2024-10-01');
  });

  it('excludes non-succeeded provisioning state', async () => {
    mockArm([
      dep('gpt-4.1', 'OpenAI', 'gpt-4.1', '1', { chatCompletion: 'true' }),
      dep(
        'half-baked',
        'OpenAI',
        'half-baked',
        '1',
        { chatCompletion: 'true' },
        'Creating',
      ),
    ]);
    const models = await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
    expect(models.map((m) => m.deploymentName)).toEqual(['gpt-4.1']);
  });

  it('caches per account path (second call does not re-fetch)', async () => {
    mockArm(EU_DEPLOYMENTS);
    await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);
    await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('follows ARM nextLink pagination', async () => {
    mockArm(
      [],
      [
        [dep('gpt-4.1', 'OpenAI', 'gpt-4.1', '1', { chatCompletion: 'true' })],
        [dep('gpt-5.2', 'OpenAI', 'gpt-5.5', '1', { chatCompletion: 'true' })],
      ],
    );
    const models = await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(models.map((m) => m.deploymentName).sort()).toEqual([
      'gpt-4.1',
      'gpt-5.2',
    ]);
  });

  it('throws on ARM error responses', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'AuthorizationFailed',
    })) as unknown as typeof fetch;
    await expect(
      service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH),
    ).rejects.toThrow(/Failed to list model deployments/);
  });

  it('rejects an invalid resource path', async () => {
    await expect(
      service.listDeployedModels(ARM_TOKEN, '/not/a/valid/path'),
    ).rejects.toThrow(/Invalid Foundry resource path/);
  });
});
