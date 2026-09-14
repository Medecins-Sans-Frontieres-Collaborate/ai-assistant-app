import { planEuDefaultModelSwitch } from '@/lib/utils/shared/euDefaultModelSwitch';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const model = (id: string, extra: Partial<OpenAIModel> = {}): OpenAIModel =>
  ({ id, name: id, maxLength: 1, tokenLimit: 1, ...extra }) as OpenAIModel;

const models = [model('gpt-5.2-chat'), model('gpt-5.4'), model('gpt-5.4-nano')];

describe('planEuDefaultModelSwitch', () => {
  const base = {
    region: 'EU' as const,
    applied: false,
    defaultModelId: 'gpt-5.2-chat',
    models,
  };

  it('switches an EU user whose persisted default is the old model', () => {
    expect(planEuDefaultModelSwitch(base)).toEqual({
      action: 'switch',
      model: models[1],
    });
  });

  it('does nothing when already applied or the user is not EU', () => {
    expect(planEuDefaultModelSwitch({ ...base, applied: true })).toEqual({
      action: 'none',
    });
    expect(planEuDefaultModelSwitch({ ...base, region: 'US' })).toEqual({
      action: 'none',
    });
    expect(planEuDefaultModelSwitch({ ...base, region: null })).toEqual({
      action: 'none',
    });
  });

  it('marks without changing a default the user chose themselves, or never set', () => {
    expect(
      planEuDefaultModelSwitch({ ...base, defaultModelId: 'gpt-5.4-nano' }),
    ).toEqual({ action: 'mark' });
    expect(
      planEuDefaultModelSwitch({ ...base, defaultModelId: undefined }),
    ).toEqual({ action: 'mark' });
  });

  it('waits (no marker) while the target is missing, disabled, or not EU-hosted', () => {
    expect(
      planEuDefaultModelSwitch({ ...base, models: [model('gpt-5.2-chat')] }),
    ).toEqual({ action: 'none' });
    expect(
      planEuDefaultModelSwitch({
        ...base,
        models: [model('gpt-5.2-chat'), model('gpt-5.4', { isDisabled: true })],
      }),
    ).toEqual({ action: 'none' });
    expect(
      planEuDefaultModelSwitch({
        ...base,
        models: [model('gpt-5.2-chat'), model('gpt-5.4', { hostedIn: ['US'] })],
      }),
    ).toEqual({ action: 'none' });
    expect(
      planEuDefaultModelSwitch({
        ...base,
        models: [model('gpt-5.2-chat'), model('gpt-5.4', { hostedIn: ['EU'] })],
      }).action,
    ).toBe('switch');
  });
});
