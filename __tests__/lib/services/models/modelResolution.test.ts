import { DeployedModel } from '@/lib/services/models/ModelDiscoveryService';
import {
  applyRingGate,
  applyTagOverlay,
  inferProvider,
  inferSdk,
  mergeDiscoveryWithMetadata,
  synthesizeUnknownModel,
} from '@/lib/services/models/modelResolution';

import { OpenAIModel } from '@/types/openai';

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
    expect(inferProvider('Mistral AI')).toBeUndefined();
  });
});

describe('synthesizeUnknownModel', () => {
  it('builds a conservative, inferred-routing model from a deployment', () => {
    const m = synthesizeUnknownModel(deployed('Mistral-Large-3', 'Mistral AI'));
    expect(m.id).toBe('Mistral-Large-3');
    expect(m.name).toBe('Mistral-Large-3');
    expect(m.deploymentName).toBe('Mistral-Large-3');
    expect(m.sdk).toBe('openai');
    expect(m.provider).toBeUndefined();
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
