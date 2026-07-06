import { DeployedModel } from '@/lib/services/models/ModelDiscoveryService';
import {
  applyRingGate,
  applyTagOverlay,
  inferProvider,
  inferSdk,
  mergeDiscoveryWithMetadata,
  mergeMultiRegionDiscovery,
  synthesizeUnknownModel,
} from '@/lib/services/models/modelResolution';

import { OpenAIModel, getModelHosting, getModelTier } from '@/types/openai';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Control the per-ring gate without depending on NEXT_PUBLIC_ENV.
const mockIsModelDisabled = vi.hoisted(() => vi.fn((_id: string) => false));
vi.mock('@/config/models', () => ({
  isModelDisabled: mockIsModelDisabled,
}));

function deployed(
  deploymentName: string,
  publisher: string,
  tags: Record<string, string> = {},
): DeployedModel {
  return {
    deploymentName,
    modelName: deploymentName,
    publisher,
    capabilities: { chatCompletion: 'true' },
    provisioningState: 'Succeeded',
    tags,
  };
}

afterEach(() => {
  mockIsModelDisabled.mockReset();
  mockIsModelDisabled.mockImplementation(() => false);
});

describe('inferSdk', () => {
  it('routes OpenAI → azure-openai, Anthropic → anthropic-foundry, else → openai', () => {
    expect(inferSdk('OpenAI')).toBe('azure-openai');
    expect(inferSdk('Anthropic')).toBe('anthropic-foundry');
    expect(inferSdk('Meta')).toBe('openai');
    expect(inferSdk('DeepSeek')).toBe('openai');
    expect(inferSdk('Mistral AI')).toBe('openai');
    expect(inferSdk(undefined)).toBe('openai');
  });

  it('is case-insensitive', () => {
    expect(inferSdk('openai')).toBe('azure-openai');
    expect(inferSdk('ANTHROPIC')).toBe('anthropic-foundry');
  });
});

describe('inferProvider', () => {
  it('maps known publishers and leaves unmapped ones undefined', () => {
    expect(inferProvider('OpenAI')).toBe('openai');
    expect(inferProvider('Anthropic')).toBe('anthropic');
    expect(inferProvider('Meta')).toBe('meta');
    expect(inferProvider('DeepSeek')).toBe('deepseek');
    expect(inferProvider('xAI')).toBe('xai');
    expect(inferProvider('Mistral AI')).toBe('mistral');
    expect(inferProvider('Cohere')).toBeUndefined();
  });
});

describe('synthesizeUnknownModel', () => {
  it('builds a conservative, inferred-routing model from a deployment', () => {
    const m = synthesizeUnknownModel(deployed('Mistral-Large-3', 'Mistral AI'));
    expect(m.id).toBe('Mistral-Large-3');
    expect(m.name).toBe('Mistral-Large-3');
    expect(m.deploymentName).toBe('Mistral-Large-3');
    expect(m.sdk).toBe('openai');
    expect(m.provider).toBe('mistral');
    expect(m.supportsVision).toBe(false);
    expect(m.supportsTemperature).toBe(true); // non-azure-openai default
    expect(m.maxLength).toBeGreaterThan(0);
    expect(m.tokenLimit).toBeGreaterThan(0);
  });

  it('defaults supportsTemperature=false for azure-openai unknowns', () => {
    const m = synthesizeUnknownModel(deployed('some-gpt', 'OpenAI'));
    expect(m.sdk).toBe('azure-openai');
    expect(m.supportsTemperature).toBe(false);
  });

  it('lets ui-* tags override the inferred defaults', () => {
    const m = synthesizeUnknownModel(
      deployed('Mistral-Large-3', 'Mistral AI', {
        'ui-tagline': 'European frontier model',
        'ui-context': '256000',
        'ui-output': '8192',
        'ui-sdk': 'openai',
      }),
    );
    expect(m.tagline).toBe('European frontier model');
    expect(m.maxLength).toBe(256000);
    expect(m.tokenLimit).toBe(8192);
  });
});

describe('applyTagOverlay', () => {
  const base: OpenAIModel = {
    id: 'gpt-x',
    name: 'GPT-X',
    maxLength: 1000,
    tokenLimit: 100,
  };

  it('overlays known ui-* keys and ignores junk', () => {
    const m = applyTagOverlay(base, {
      'ui-tagline': 'Fast',
      'ui-context': '200000',
      'ui-output': '64000',
      'ui-agent-id': 'gpt-x-agent',
      'ui-context-bogus': 'nope',
    });
    expect(m.tagline).toBe('Fast');
    expect(m.maxLength).toBe(200000);
    expect(m.tokenLimit).toBe(64000);
    expect(m.agentId).toBe('gpt-x-agent');
    expect(m.isAgent).toBe(true);
  });

  it('ignores non-positive / non-numeric size tags', () => {
    const m = applyTagOverlay(base, { 'ui-context': 'abc', 'ui-output': '-5' });
    expect(m.maxLength).toBe(1000);
    expect(m.tokenLimit).toBe(100);
  });

  it('rejects hex / scientific-notation / padded size tags but accepts plain ints', () => {
    // Number() would accept all of these; positiveInt must not.
    expect(applyTagOverlay(base, { 'ui-context': '0x20000' }).maxLength).toBe(
      1000,
    );
    expect(applyTagOverlay(base, { 'ui-context': '1e8' }).maxLength).toBe(1000);
    expect(applyTagOverlay(base, { 'ui-context': ' 5 ' }).maxLength).toBe(5);
    expect(applyTagOverlay(base, { 'ui-context': '200000' }).maxLength).toBe(
      200000,
    );
  });

  it('drops an unknown ui-sdk and leaves the model unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withSdk: OpenAIModel = { ...base, sdk: 'azure-openai' };
    const m = applyTagOverlay(withSdk, { 'ui-sdk': 'totally-bogus' });
    expect(m.sdk).toBe('azure-openai');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accepts a valid ui-sdk', () => {
    const m = applyTagOverlay(base, { 'ui-sdk': 'anthropic-foundry' });
    expect(m.sdk).toBe('anthropic-foundry');
  });

  it('drops an unknown ui-provider and leaves the model unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withProvider: OpenAIModel = { ...base, provider: 'openai' };
    const m = applyTagOverlay(withProvider, { 'ui-provider': 'cohere' });
    expect(m.provider).toBe('openai');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accepts a valid ui-provider', () => {
    const m = applyTagOverlay(base, { 'ui-provider': 'anthropic' });
    expect(m.provider).toBe('anthropic');
  });

  it('sets agentId + isAgent from ui-agent-id', () => {
    const m = applyTagOverlay(base, { 'ui-agent-id': 'agent-7' });
    expect(m.agentId).toBe('agent-7');
    expect(m.isAgent).toBe(true);
  });

  it('clears isAgent on ui-is-agent:false opt-out', () => {
    const asAgent: OpenAIModel = { ...base, isAgent: true };
    const m = applyTagOverlay(asAgent, { 'ui-is-agent': 'false' });
    expect(m.isAgent).toBe(false);
  });

  it('returns the model unchanged when there are no tags', () => {
    expect(applyTagOverlay(base, {})).toEqual(base);
  });
});

describe('mergeDiscoveryWithMetadata', () => {
  const metadata: Record<string, OpenAIModel> = {
    'gpt-5.2': {
      id: 'gpt-5.2',
      name: 'GPT-5.2',
      maxLength: 128000,
      tokenLimit: 16000,
      sdk: 'azure-openai',
    },
    'claude-opus-4-6': {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      maxLength: 200000,
      tokenLimit: 64000,
      sdk: 'anthropic-foundry',
    },
  };

  it('enriches known deployed models and drops undeployed-but-known ones', () => {
    // Only gpt-5.2 is deployed; claude is in metadata but NOT deployed (the EU drift case).
    const out = mergeDiscoveryWithMetadata(
      [deployed('gpt-5.2', 'OpenAI')],
      metadata,
      { showUnknown: false },
    );
    expect(out.map((m) => m.id)).toEqual(['gpt-5.2']);
    expect(out[0].name).toBe('GPT-5.2'); // enriched from metadata
  });

  it('hides unknown deployed models when showUnknown=false', () => {
    const out = mergeDiscoveryWithMetadata(
      [
        deployed('gpt-5.2', 'OpenAI'),
        deployed('Mistral-Large-3', 'Mistral AI'),
      ],
      metadata,
      { showUnknown: false },
    );
    expect(out.map((m) => m.id)).toEqual(['gpt-5.2']);
  });

  it('surfaces unknown deployed models (synthesized) when showUnknown=true', () => {
    const out = mergeDiscoveryWithMetadata(
      [
        deployed('gpt-5.2', 'OpenAI'),
        deployed('Mistral-Large-3', 'Mistral AI'),
      ],
      metadata,
      { showUnknown: true },
    );
    expect(out.map((m) => m.id).sort()).toEqual(['Mistral-Large-3', 'gpt-5.2']);
    const mistral = out.find((m) => m.id === 'Mistral-Large-3');
    expect(mistral?.sdk).toBe('openai'); // inferred routing so chat works
  });

  it('applies ui-* tag overlay to known models too', () => {
    const out = mergeDiscoveryWithMetadata(
      [deployed('gpt-5.2', 'OpenAI', { 'ui-tagline': 'Tagged!' })],
      metadata,
      { showUnknown: false },
    );
    expect(out[0].tagline).toBe('Tagged!');
  });
});

describe('applyRingGate', () => {
  const models: OpenAIModel[] = [
    { id: 'gpt-5.2', name: 'a', maxLength: 1, tokenLimit: 1 },
    { id: 'grok-3', name: 'b', maxLength: 1, tokenLimit: 1, isDisabled: true },
    { id: 'beta-model', name: 'c', maxLength: 1, tokenLimit: 1 },
  ];

  it('drops models flagged isDisabled', () => {
    const out = applyRingGate(models);
    expect(out.map((m) => m.id)).not.toContain('grok-3');
  });

  it('drops models disabled for the current ring (config/models)', () => {
    mockIsModelDisabled.mockImplementation((id) => id === 'beta-model');
    const out = applyRingGate(models);
    expect(out.map((m) => m.id)).toEqual(['gpt-5.2']);
  });
});

describe('applyTagOverlay ui-tier / ui-hosting', () => {
  const base: OpenAIModel = {
    id: 'm',
    name: 'm',
    maxLength: 1000,
    tokenLimit: 100,
  };

  it('applies a valid ui-tier', () => {
    expect(applyTagOverlay(base, { 'ui-tier': 'featured' }).tier).toBe(
      'featured',
    );
    expect(applyTagOverlay(base, { 'ui-tier': 'legacy' }).tier).toBe('legacy');
  });

  it('ignores an unknown ui-tier value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      applyTagOverlay(base, { 'ui-tier': 'super-special' }).tier,
    ).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('never lets a tag set hosting (compliance property)', () => {
    // There is intentionally no ui-hosting overlay: an ARM tag must not be
    // able to relabel where inference runs.
    const m = applyTagOverlay({ ...base, hosting: 'external' }, {
      'ui-hosting': 'azure',
    } as Record<string, string>);
    expect(m.hosting).toBe('external');
  });
});

describe('getModelHosting / getModelTier defaults', () => {
  it('defaults hosting to azure and tier to standard', () => {
    expect(getModelHosting({})).toBe('azure');
    expect(getModelTier({})).toBe('standard');
    expect(getModelHosting({ hosting: 'external' })).toBe('external');
    expect(getModelTier({ tier: 'legacy' })).toBe('legacy');
  });

  it('synthesized unknowns default to azure/standard via the helpers', () => {
    const m = synthesizeUnknownModel(deployed('mystery-model', 'Acme AI'));
    expect(m.hosting).toBeUndefined();
    expect(m.tier).toBeUndefined();
    expect(getModelHosting(m)).toBe('azure');
    expect(getModelTier(m)).toBe('standard');
  });
});

describe('mergeMultiRegionDiscovery', () => {
  const metadata: Record<string, OpenAIModel> = {
    'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2', maxLength: 1, tokenLimit: 1 },
    'Mistral-Large-3': {
      id: 'Mistral-Large-3',
      name: 'Mistral Large 3',
      maxLength: 1,
      tokenLimit: 1,
    },
  };

  it('tags each model with every region it is deployed in', () => {
    const out = mergeMultiRegionDiscovery(
      [
        {
          region: 'US',
          deployed: [deployed('gpt-5.2', 'OpenAI')],
        },
        {
          region: 'EU',
          deployed: [
            deployed('gpt-5.2', 'OpenAI'),
            deployed('Mistral-Large-3', 'Mistral AI'),
          ],
        },
      ],
      metadata,
      { showUnknown: false },
    );
    const byId = Object.fromEntries(out.map((m) => [m.id, m]));
    expect(byId['gpt-5.2'].hostedIn).toEqual(['US', 'EU']);
    expect(byId['Mistral-Large-3'].hostedIn).toEqual(['EU']);
  });

  it('is first-wins on collisions: home tags survive, foreign only extends hostedIn', () => {
    const out = mergeMultiRegionDiscovery(
      [
        {
          region: 'US',
          deployed: [deployed('gpt-5.2', 'OpenAI', { 'ui-tagline': 'home' })],
        },
        {
          region: 'EU',
          deployed: [
            deployed('gpt-5.2', 'OpenAI', { 'ui-tagline': 'foreign' }),
          ],
        },
      ],
      metadata,
      { showUnknown: false },
    );
    expect(out).toHaveLength(1);
    expect(out[0].tagline).toBe('home');
    expect(out[0].hostedIn).toEqual(['US', 'EU']);
  });

  it('does not duplicate a region seen twice', () => {
    const out = mergeMultiRegionDiscovery(
      [
        { region: 'EU', deployed: [deployed('gpt-5.2', 'OpenAI')] },
        { region: 'EU', deployed: [deployed('gpt-5.2', 'OpenAI')] },
      ],
      metadata,
      { showUnknown: false },
    );
    expect(out[0].hostedIn).toEqual(['EU']);
  });

  it('returns [] for no regions', () => {
    expect(
      mergeMultiRegionDiscovery([], metadata, { showUnknown: false }),
    ).toEqual([]);
  });
});
