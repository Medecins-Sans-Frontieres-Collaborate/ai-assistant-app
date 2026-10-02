import { pickWebSearchModel } from '@/lib/services/models/webSearchModel';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

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
