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

// Spy on global.fetch so vi.restoreAllMocks() cleanly un-installs it after each
// test (a raw `global.fetch = vi.fn()` would leak the mock across test files).
function spyFetch(impl: (url: string) => Promise<unknown>) {
  return vi
    .spyOn(global, 'fetch')
    .mockImplementation(impl as unknown as typeof fetch);
}

function mockArm(deployments: unknown[], pages?: unknown[][]) {
  // If `pages` given, serve multi-page with nextLink; else a single page.
  if (pages) {
    let i = 0;
    return spyFetch(async () => {
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
    });
  }
  return spyFetch(async () => ({
    ok: true,
    json: async () => ({ value: deployments }),
  }));
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

  it('clearCache(path) evicts only that account, leaving other regions cached', async () => {
    const OTHER_ACCOUNT =
      '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/ts-aiassist-live-us';
    mockArm(EU_DEPLOYMENTS);

    // Warm both regions (2 fetches).
    await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);
    await service.listDeployedModels(ARM_TOKEN, OTHER_ACCOUNT);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // Evict only the EU account (passing the project path; it gets stripped).
    service.clearCache(PROJECT_PATH);

    // EU re-fetches (3); the other region is still cached (no extra fetch).
    await service.listDeployedModels(ARM_TOKEN, PROJECT_PATH);
    await service.listDeployedModels(ARM_TOKEN, OTHER_ACCOUNT);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('dedups concurrent cold-cache calls into a single fetch (stampede)', async () => {
    mockArm(EU_DEPLOYMENTS);
    const [a, b, c] = await Promise.all([
      service.listDeployedModels(ARM_TOKEN, PROJECT_PATH),
      service.listDeployedModels(ARM_TOKEN, PROJECT_PATH),
      service.listDeployedModels(ARM_TOKEN, PROJECT_PATH),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // All callers resolve to the same discovered list.
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('does not pin an empty result for the full TTL (re-fetches after the short window)', async () => {
    vi.useFakeTimers();
    try {
      mockArm([]);
      const first = await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
      expect(first).toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Within the short empty-TTL window: still served from cache.
      vi.advanceTimersByTime(30 * 1000);
      await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Past the 60s empty-TTL: the transient emptiness is re-discovered.
      vi.advanceTimersByTime(40 * 1000);
      await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps non-empty results cached past the short empty-TTL window', async () => {
    vi.useFakeTimers();
    try {
      mockArm(EU_DEPLOYMENTS);
      await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
      // Well past the 60s empty-TTL but inside the 1h full TTL.
      vi.advanceTimersByTime(5 * 60 * 1000);
      await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops paginating when nextLink points at a non-ARM host', async () => {
    let calls = 0;
    spyFetch(async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          value: [
            dep('gpt-4.1', 'OpenAI', 'gpt-4.1', '1', {
              chatCompletion: 'true',
            }),
          ],
          // Tampered nextLink to a foreign origin — must NOT be followed.
          nextLink: 'https://evil.example.com/management?steal=token',
        }),
      } as Response;
    });

    const models = await service.listDeployedModels(ARM_TOKEN, ACCOUNT_PATH);
    expect(calls).toBe(1);
    expect(models.map((m) => m.deploymentName)).toEqual(['gpt-4.1']);
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
    spyFetch(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'AuthorizationFailed',
    }));
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
