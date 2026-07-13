import { DeployedModel } from '@/lib/services/models/ModelDiscoveryService';
import {
  armTokenCacheScope,
  buildCustomSourceModel,
  buildCustomSourceModelId,
  clearAccountLocationCache,
  getAccountLocation,
  resolveCustomSourceModel,
} from '@/lib/services/models/customModelSources';

import { shortSourceHash } from '@/lib/utils/app/agentId';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// resolveCustomSourceModel discovers via the singleton service; mock it so the
// resolver tests control the deployment list. buildCustomSourceModel is pure
// and never touches the mock.
const mockListDeployedModels = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/models/ModelDiscoveryService', () => ({
  ModelDiscoveryService: {
    getInstance: () => ({ listDeployedModels: mockListDeployedModels }),
  },
}));

const ACCOUNT_PATH =
  '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-own-foundry';
const PROJECT_PATH = `${ACCOUNT_PATH}/projects/default`;
const OTHER_ACCOUNT_PATH =
  '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/someone-elses';
const ARM_TOKEN = 'user-arm-token';

function deployed(
  deploymentName: string,
  publisher = 'OpenAI',
  tags: Record<string, string> = {},
  modelVersion?: string,
): DeployedModel {
  return {
    deploymentName,
    modelName: deploymentName,
    modelVersion,
    publisher,
    capabilities: { chatCompletion: 'true' },
    provisioningState: 'Succeeded',
    tags,
  };
}

beforeEach(() => {
  mockListDeployedModels.mockResolvedValue([]);
  clearAccountLocationCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('buildCustomSourceModelId', () => {
  it('follows the byom-<hash>-<deployment> convention', () => {
    expect(buildCustomSourceModelId(ACCOUNT_PATH, 'gpt-5.2')).toBe(
      `byom-${shortSourceHash(ACCOUNT_PATH)}-gpt-5.2`,
    );
  });
});

describe('armTokenCacheScope', () => {
  it('is the full sha256 hex digest of the token', () => {
    expect(armTokenCacheScope(ARM_TOKEN)).toBe(
      createHash('sha256').update(ARM_TOKEN).digest('hex'),
    );
  });
});

describe('buildCustomSourceModel', () => {
  it('joins known metadata by deployment name and overrides identity fields', () => {
    const meta = OpenAIModels[OpenAIModelID.GPT_5_2];
    const model = buildCustomSourceModel(deployed('gpt-5.2'), ACCOUNT_PATH);

    expect(model.id).toBe(`byom-${shortSourceHash(ACCOUNT_PATH)}-gpt-5.2`);
    expect(model.modelSource).toBe(ACCOUNT_PATH);
    expect(model.isCustomSourceModel).toBe(true);
    expect(model.deploymentName).toBe('gpt-5.2');
    // Metadata join: display + routing fields come from config, not synthesis.
    expect(model.name).toBe(meta.name);
    expect(model.maxLength).toBe(meta.maxLength);
    expect(model.sdk).toBe(meta.sdk);
  });

  it('strips app-policy curation/gating fields so byom models ignore app policy', () => {
    // gpt-5.2 metadata carries tier + isRecommended — assert the strip
    // removes the policy surface while family metadata survives (below).
    const meta = OpenAIModels[OpenAIModelID.GPT_5_2];
    expect(meta.tier).toBeDefined();
    expect(meta.isRecommended).toBe(true);
    const model = buildCustomSourceModel(deployed('gpt-5.2'), ACCOUNT_PATH);
    for (const field of ['tier', 'isRecommended', 'agentId', 'isAgent']) {
      expect(model).not.toHaveProperty(field);
    }
  });

  it('retains family metadata so byom models group into their own hierarchy', () => {
    const meta = OpenAIModels[OpenAIModelID.GPT_5_2];
    // Guard against vacuous undefined === undefined comparisons.
    expect(meta.seriesLabel).toBe('GPT');
    const model = buildCustomSourceModel(deployed('gpt-5.2'), ACCOUNT_PATH);
    expect(model.seriesLabel).toBe(meta.seriesLabel);
    expect(model.versionLabel).toBe(meta.versionLabel);
    expect(model.variant).toBe(meta.variant);
    expect(model.variantLabel).toBe(meta.variantLabel);
    expect(model.variantRank).toBe(meta.variantRank);
    expect(model.defaultRank).toBe(meta.defaultRank);
  });

  it('namespaces series per source (same account groups, different accounts never merge)', () => {
    const a = buildCustomSourceModel(deployed('gpt-5.2'), ACCOUNT_PATH);
    const sibling = buildCustomSourceModel(deployed('gpt-4.1'), ACCOUNT_PATH);
    const other = buildCustomSourceModel(
      deployed('gpt-5.2'),
      OTHER_ACCOUNT_PATH,
    );

    expect(a.series).toBe(`byom-${shortSourceHash(ACCOUNT_PATH)}:gpt`);
    // Same account + same catalog family ⇒ one byom family.
    expect(sibling.series).toBe(a.series);
    // Another account's identical deployment must NOT share the family…
    expect(other.series).toBe(
      `byom-${shortSourceHash(OTHER_ACCOUNT_PATH)}:gpt`,
    );
    expect(other.series).not.toBe(a.series);
    // …and neither collides with the catalog family key.
    expect(a.series).not.toBe(OpenAIModels[OpenAIModelID.GPT_5_2].series);
  });

  it('leaves synthesized unknown deployments without a series (standalone rows)', () => {
    const model = buildCustomSourceModel(
      deployed('Totally-New-Model', 'Acme AI'),
      ACCOUNT_PATH,
    );
    expect(model).not.toHaveProperty('series');
    expect(model).not.toHaveProperty('seriesLabel');
  });

  it('sets sourceLocation from opts and deploymentModelVersion from discovery', () => {
    const model = buildCustomSourceModel(
      deployed('gpt-5.2', 'OpenAI', {}, '2025-04-14'),
      ACCOUNT_PATH,
      { location: 'swedencentral' },
    );
    expect(model.sourceLocation).toBe('swedencentral');
    expect(model.deploymentModelVersion).toBe('2025-04-14');
  });

  it('omits sourceLocation/deploymentModelVersion when unknown', () => {
    const model = buildCustomSourceModel(deployed('gpt-5.2'), ACCOUNT_PATH);
    expect(model).not.toHaveProperty('sourceLocation');
    expect(model).not.toHaveProperty('deploymentModelVersion');
  });

  it('strips hostedIn injected at runtime by the dual-region merge', () => {
    // Static metadata never carries hostedIn — it is added to OpenAIModels at
    // runtime by the dual-region merge. Inject it here so the assertion
    // actually exercises the strip (a bare not-toHaveProperty check would
    // pass vacuously against the static entry).
    const meta = OpenAIModels[OpenAIModelID.GPT_5_2];
    expect(meta).not.toHaveProperty('hostedIn');
    meta.hostedIn = ['US', 'EU'];
    try {
      const model = buildCustomSourceModel(deployed('gpt-5.2'), ACCOUNT_PATH);
      expect(model).not.toHaveProperty('hostedIn');
    } finally {
      delete meta.hostedIn;
    }
  });

  it('forces isDisabled to false and drops lifecycle/retirement (app policy ignored)', () => {
    // grok-3 is metadata-disabled AND retired — the user's own deployment
    // ignores both.
    expect(OpenAIModels[OpenAIModelID.GROK_3].isDisabled).toBe(true);
    const model = buildCustomSourceModel(
      deployed('grok-3', 'xAI'),
      ACCOUNT_PATH,
    );
    expect(model.isDisabled).toBe(false);
    expect(model).not.toHaveProperty('lifecycle');
    expect(model).not.toHaveProperty('retirementDate');
    expect(model).not.toHaveProperty('retirementReplacement');
  });

  it('keeps hosting as metadata says (claude byom stays external)', () => {
    expect(OpenAIModels[OpenAIModelID.CLAUDE_OPUS_4_6].hosting).toBe(
      'external',
    );
    const model = buildCustomSourceModel(
      deployed('claude-opus-4-6', 'Anthropic'),
      ACCOUNT_PATH,
    );
    expect(model.hosting).toBe('external');
    expect(model.sdk).toBe('anthropic-foundry');
  });

  it('synthesizes unknown deployments with inferred routing and conservative limits', () => {
    const model = buildCustomSourceModel(
      deployed('Totally-New-Model', 'Acme AI'),
      ACCOUNT_PATH,
    );
    expect(model.id).toBe(
      `byom-${shortSourceHash(ACCOUNT_PATH)}-Totally-New-Model`,
    );
    expect(model.name).toBe('Totally-New-Model');
    expect(model.sdk).toBe('openai'); // unmapped publisher → OpenAI-compatible
    expect(model.maxLength).toBe(32000);
    expect(model.tokenLimit).toBe(4096);
    expect(model.isCustomSourceModel).toBe(true);
    expect(model.isDisabled).toBe(false);
  });

  it('infers the anthropic SDK for unknown Anthropic deployments', () => {
    const model = buildCustomSourceModel(
      deployed('claude-next-99', 'Anthropic'),
      ACCOUNT_PATH,
    );
    expect(model.sdk).toBe('anthropic-foundry');
  });

  it('applies the ui-* ARM tag overlay on known models', () => {
    const model = buildCustomSourceModel(
      deployed('gpt-5.2', 'OpenAI', { 'ui-tagline': 'my own gpt' }),
      ACCOUNT_PATH,
    );
    expect(model.tagline).toBe('my own gpt');
  });
});

describe('resolveCustomSourceModel', () => {
  const modelId = buildCustomSourceModelId(ACCOUNT_PATH, 'gpt-5.2');

  it('resolves a deployed model, discovering with a user-scoped cache', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    const model = await resolveCustomSourceModel(
      ARM_TOKEN,
      modelId,
      ACCOUNT_PATH,
    );
    expect(model).not.toBeNull();
    expect(model?.id).toBe(modelId);
    expect(model?.modelSource).toBe(ACCOUNT_PATH);
    expect(mockListDeployedModels).toHaveBeenCalledWith(
      ARM_TOKEN,
      ACCOUNT_PATH,
      { cacheScope: armTokenCacheScope(ARM_TOKEN) },
    );
  });

  it('strips a project-scoped source path to the account before hash + discovery', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    // Id minted for the ACCOUNT resolves even when the client sends the
    // project path the source was configured with.
    const model = await resolveCustomSourceModel(
      ARM_TOKEN,
      modelId,
      PROJECT_PATH,
    );
    expect(model?.id).toBe(modelId);
    expect(mockListDeployedModels).toHaveBeenCalledWith(
      ARM_TOKEN,
      ACCOUNT_PATH,
      expect.anything(),
    );
  });

  it('parses deployment names containing dashes and dots', async () => {
    mockListDeployedModels.mockResolvedValue([
      deployed('DeepSeek-V3.1', 'DeepSeek'),
    ]);
    const model = await resolveCustomSourceModel(
      ARM_TOKEN,
      buildCustomSourceModelId(ACCOUNT_PATH, 'DeepSeek-V3.1'),
      ACCOUNT_PATH,
    );
    expect(model?.deploymentName).toBe('DeepSeek-V3.1');
  });

  it('returns null for an invalid source path without touching discovery', async () => {
    const model = await resolveCustomSourceModel(
      ARM_TOKEN,
      modelId,
      '/not/a/valid/path',
    );
    expect(model).toBeNull();
    expect(mockListDeployedModels).not.toHaveBeenCalled();
  });

  it('returns null on hash mismatch (id minted for a different account)', async () => {
    // Integrity check: the same deployment name from another account must not
    // resolve — the id binds the model to its source.
    const foreignId = buildCustomSourceModelId(OTHER_ACCOUNT_PATH, 'gpt-5.2');
    const model = await resolveCustomSourceModel(
      ARM_TOKEN,
      foreignId,
      ACCOUNT_PATH,
    );
    expect(model).toBeNull();
    expect(mockListDeployedModels).not.toHaveBeenCalled();
  });

  it('returns null when the deployment no longer exists in the account', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('o3')]);
    const model = await resolveCustomSourceModel(
      ARM_TOKEN,
      modelId,
      ACCOUNT_PATH,
    );
    expect(model).toBeNull();
  });

  it('propagates discovery errors (caller fails closed)', async () => {
    mockListDeployedModels.mockRejectedValue(new Error('ARM 403'));
    await expect(
      resolveCustomSourceModel(ARM_TOKEN, modelId, ACCOUNT_PATH),
    ).rejects.toThrow('ARM 403');
  });
});

describe('getAccountLocation', () => {
  it('refuses to build an ARM URL from an invalid path (no fetch, no token leak)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      getAccountLocation(ARM_TOKEN, 'https://evil.example.com/#'),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads .location from the ARM account resource with the given bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ location: 'francecentral' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(getAccountLocation(ARM_TOKEN, ACCOUNT_PATH)).resolves.toBe(
      'francecentral',
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://management.azure.com${ACCOUNT_PATH}?api-version=2025-12-01`,
      { headers: { Authorization: `Bearer ${ARM_TOKEN}` } },
    );
  });

  it('returns undefined (never throws) on non-OK responses and network errors, and does not cache failures', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ location: 'swedencentral' }),
      });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      getAccountLocation(ARM_TOKEN, ACCOUNT_PATH),
    ).resolves.toBeUndefined();
    await expect(
      getAccountLocation(ARM_TOKEN, ACCOUNT_PATH),
    ).resolves.toBeUndefined();
    // Failures were not cached — the third call retries and succeeds.
    await expect(getAccountLocation(ARM_TOKEN, ACCOUNT_PATH)).resolves.toBe(
      'swedencentral',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('caches successful lookups per account path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ location: 'swedencentral' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await getAccountLocation(ARM_TOKEN, ACCOUNT_PATH);
    await expect(getAccountLocation(ARM_TOKEN, ACCOUNT_PATH)).resolves.toBe(
      'swedencentral',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // A different account is its own cache entry.
    await getAccountLocation(ARM_TOKEN, OTHER_ACCOUNT_PATH);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
