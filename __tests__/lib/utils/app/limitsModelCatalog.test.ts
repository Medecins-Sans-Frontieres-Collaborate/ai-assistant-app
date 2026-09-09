import {
  buildQualifierCatalog,
  isUnknownQualifier,
  qualifierLabel,
} from '@/lib/utils/app/limitsModelCatalog';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it } from 'vitest';

function model(partial: Partial<OpenAIModel> & { id: string }): OpenAIModel {
  return {
    name: partial.id,
    maxLength: 0,
    tokenLimit: 0,
    ...partial,
  } as OpenAIModel;
}

const MODELS = [
  model({ id: 'gpt-5.2', name: 'GPT-5.2', series: 'gpt', seriesLabel: 'GPT' }),
  model({
    id: 'gpt-5.2-chat',
    name: 'GPT-5.2 Chat',
    series: 'gpt',
    seriesLabel: 'GPT',
  }),
  model({
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    series: 'claude',
    seriesLabel: 'Claude',
  }),
  // Deliberately no series — must never be folded into a family.
  model({ id: 'lonely-model', name: 'Lonely' }),
];

describe('buildQualifierCatalog', () => {
  it('groups models into families by series', () => {
    const { families } = buildQualifierCatalog(MODELS);
    const gpt = families.find((f) => f.series === 'gpt');
    expect(gpt?.label).toBe('GPT');
    expect(gpt?.modelIds).toEqual(['gpt-5.2', 'gpt-5.2-chat']);
  });

  it('produces NO family for a model that declares no series', () => {
    const { families, models } = buildQualifierCatalog(MODELS);
    // Matches the resolver, which emits no `family:` cell for such a model.
    expect(families.map((f) => f.series)).toEqual(['claude', 'gpt']);
    expect(models.some((m) => m.modelId === 'lonely-model')).toBe(true);
  });

  it('offers every model as a specific target', () => {
    const { models } = buildQualifierCatalog(MODELS);
    expect(models).toHaveLength(4);
  });

  it('falls back to the id when a model has no display name', () => {
    const { models } = buildQualifierCatalog([model({ id: 'bare', name: '' })]);
    expect(models[0].label).toBe('bare');
  });

  it('handles an empty catalog without throwing', () => {
    expect(buildQualifierCatalog([])).toEqual({ families: [], models: [] });
  });
});

describe('isUnknownQualifier', () => {
  const catalog = buildQualifierCatalog(MODELS);

  it('recognises a model and a family that exist', () => {
    expect(isUnknownQualifier(catalog, { modelId: 'gpt-5.2' })).toBe(false);
    expect(isUnknownQualifier(catalog, { series: 'gpt' })).toBe(false);
  });

  it('flags a model absent from this ring rather than treating it as corrupt', () => {
    // Model ids vary per ring/region; a stored limit MUST survive absence.
    expect(isUnknownQualifier(catalog, { modelId: 'gpt-9-unreleased' })).toBe(
      true,
    );
    expect(isUnknownQualifier(catalog, { series: 'mistral' })).toBe(true);
  });

  it('matches case-insensitively, as the resolver does', () => {
    expect(isUnknownQualifier(catalog, { modelId: 'GPT-5.2' })).toBe(false);
  });

  it('treats an unqualified cell as always known', () => {
    expect(isUnknownQualifier(catalog, {})).toBe(false);
  });
});

describe('qualifierLabel', () => {
  const catalog = buildQualifierCatalog(MODELS);

  it('prefers the display name', () => {
    expect(qualifierLabel(catalog, { modelId: 'gpt-5.2' })).toBe('GPT-5.2');
    expect(qualifierLabel(catalog, { series: 'claude' })).toBe('Claude');
  });

  it('falls back to the raw id for a qualifier this ring does not serve', () => {
    expect(qualifierLabel(catalog, { modelId: 'gpt-9' })).toBe('gpt-9');
  });
});
