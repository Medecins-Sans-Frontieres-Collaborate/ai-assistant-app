import { discoverServedModels } from '@/lib/services/models/servedModels';
import {
  clearWebSearchModelCache,
  pickWebSearchModel,
  resolveWebSearchModel,
} from '@/lib/services/models/webSearchModel';

import {
  ModelListSource,
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
} from '@/types/openai';

import { env } from '@/config/environment';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW + days * DAY).toISOString();

const served = (id: string, facts: Partial<OpenAIModel> = {}): OpenAIModel => ({
  ...OpenAIModels[id as OpenAIModelID],
  hostedIn: ['US'],
  ...facts,
});

describe('pickWebSearchModel', () => {
  it('picks the policy default (gpt-5.4) when it is served and staying', () => {
    expect(
      pickWebSearchModel(
        [served('gpt-5.2'), served('gpt-5.4'), served('gpt-6-astra')],
        'US',
        NOW,
      ),
    ).toBe('gpt-5.4');
  });

  it('moves off the default when it is retiring, exactly as a conversation would', () => {
    expect(
      pickWebSearchModel(
        [
          served('gpt-5.4', { retiresAt: inDays(5) }),
          served('gpt-5.5'),
          served('gpt-6-astra'),
        ],
        'US',
        NOW,
      ),
    ).not.toBe('gpt-5.4');
  });

  it('skips forced retirements and repointed deployments', () => {
    // gpt-5.2 is on the forced list; a deployment that already runs another
    // served model is an alias.
    expect(
      pickWebSearchModel(
        [
          served('gpt-5.2'),
          served('gpt-5.1', { deploymentModelName: 'gpt-5.5' }),
          served('gpt-5.5'),
        ],
        'US',
        NOW,
      ),
    ).toBe('gpt-5.5');
  });

  it('only considers OpenAI Responses-API models hosted in the region', () => {
    expect(
      pickWebSearchModel(
        [
          served('claude-sonnet-5'), // not OpenAI
          served('gpt-5.2-chat'), // chat completions only
          served('gpt-5.4', { hostedIn: ['US'] }), // not in the EU
          served('gpt-5.5', { hostedIn: ['EU'] }),
        ],
        'EU',
        NOW,
      ),
    ).toBe('gpt-5.5');
    expect(
      pickWebSearchModel([served('claude-sonnet-5')], 'US', NOW),
    ).toBeNull();
  });

  it('judges a dual-region model by the region it is asked for', () => {
    const list = [
      served('gpt-5.4', {
        hostedIn: ['US', 'EU'],
        retirementByRegion: { US: { retiresAt: inDays(3) }, EU: {} },
      }),
      served('gpt-5.5', { hostedIn: ['US', 'EU'] }),
    ];
    expect(pickWebSearchModel(list, 'US', NOW)).toBe('gpt-5.5');
    expect(pickWebSearchModel(list, 'EU', NOW)).toBe('gpt-5.4');
  });
});

describe('resolveWebSearchModel', () => {
  const discovered = vi.hoisted(() => ({
    value: {
      models: [] as OpenAIModel[],
      source: 'discovery' as ModelListSource,
    },
  }));
  vi.mock('@/lib/services/models/servedModels', () => ({
    discoverServedModels: vi.fn(async () => discovered.value),
  }));

  beforeEach(() => {
    clearWebSearchModelCache();
    delete (env as { WEB_SEARCH_RESPONSES_MODEL?: string })
      .WEB_SEARCH_RESPONSES_MODEL;
    vi.mocked(discoverServedModels).mockClear();
    discovered.value = {
      models: [served('gpt-5.4'), served('gpt-6-astra')],
      source: 'discovery',
    };
  });

  it('honours the env pin without discovering anything', async () => {
    (
      env as { WEB_SEARCH_RESPONSES_MODEL?: string }
    ).WEB_SEARCH_RESPONSES_MODEL = 'gpt-6-astra';
    expect(await resolveWebSearchModel('US')).toBe('gpt-6-astra');
    expect(discoverServedModels).not.toHaveBeenCalled();
  });

  it('picks from the served list and caches the pick per region', async () => {
    expect(await resolveWebSearchModel('US')).toBe('gpt-5.4');
    expect(await resolveWebSearchModel('US')).toBe('gpt-5.4');
    expect(discoverServedModels).toHaveBeenCalledTimes(1);
    // Another region is its own discovery and its own cache entry.
    discovered.value = {
      models: [served('gpt-5.4', { hostedIn: ['EU'] })],
      source: 'discovery',
    };
    expect(await resolveWebSearchModel('EU')).toBe('gpt-5.4');
    expect(discoverServedModels).toHaveBeenCalledTimes(2);
  });

  it('keeps a pick from the static fallback only briefly', async () => {
    vi.useFakeTimers();
    try {
      discovered.value = { ...discovered.value, source: 'fallback' };
      await resolveWebSearchModel('US');
      vi.advanceTimersByTime(45 * 1000);
      await resolveWebSearchModel('US');
      expect(discoverServedModels).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses rather than falling back to a deployment that cannot run the tool', async () => {
    discovered.value = {
      models: [served('gpt-5.2-chat'), served('claude-sonnet-5')],
      source: 'discovery',
    };
    await expect(resolveWebSearchModel('US')).rejects.toThrow(
      /No web-search-capable deployment is served in the US region/,
    );
  });
});
