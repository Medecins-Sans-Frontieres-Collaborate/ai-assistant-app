import {
  getSeriesVersions,
  seriesRepresentative,
  versionRank,
} from '@/lib/utils/app/modelSeries';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const model = (
  id: string,
  versionLabel?: string,
  extra: Partial<OpenAIModel> = {},
): OpenAIModel => ({
  id,
  name: id,
  maxLength: 1,
  tokenLimit: 1,
  series: 'gpt',
  versionLabel,
  ...extra,
});

describe('versionRank', () => {
  it('parses numeric version labels, including suffixed ones', () => {
    expect(versionRank({ versionLabel: '5.4' })).toBe(5.4);
    expect(versionRank({ versionLabel: '4o' })).toBe(4);
    expect(versionRank({ versionLabel: '3.2' })).toBe(3.2);
  });

  it('ranks unparseable/missing labels last', () => {
    expect(versionRank({ versionLabel: undefined })).toBe(-1);
    expect(versionRank({ versionLabel: 'preview' })).toBe(-1);
  });
});

describe('getSeriesVersions', () => {
  it('returns series members newest-first and ignores other series', () => {
    const models = [
      model('gpt-4.1', '4.1'),
      model('other', '9', { series: 'other' }),
      model('gpt-5.4', '5.4'),
      model('gpt-5', '5'),
    ];
    expect(
      getSeriesVersions(models, { series: 'gpt' }).map((m) => m.id),
    ).toEqual(['gpt-5.4', 'gpt-5', 'gpt-4.1']);
  });

  it('returns [] when the model has no series', () => {
    expect(getSeriesVersions([model('x', '1')], { series: undefined })).toEqual(
      [],
    );
  });
});

describe('seriesRepresentative', () => {
  const versions = [
    model('gpt-5.4', '5.4'),
    model('gpt-5.2', '5.2', { tier: 'featured' }),
    model('gpt-5', '5', { tier: 'legacy' }),
  ];

  it('prefers the current selection', () => {
    expect(seriesRepresentative(versions, 'gpt-5')?.id).toBe('gpt-5');
  });

  it('prefers the FEATURED version over the newest (row fronts the vetted default)', () => {
    expect(seriesRepresentative(versions, undefined)?.id).toBe('gpt-5.2');
  });

  it('falls back to newest non-legacy, then newest', () => {
    const noFeatured = [
      model('gpt-5.4', '5.4', { tier: 'legacy' }),
      model('gpt-5.2', '5.2'),
    ];
    expect(seriesRepresentative(noFeatured, undefined)?.id).toBe('gpt-5.2');
    const allLegacy = [model('gpt-5.4', '5.4', { tier: 'legacy' })];
    expect(seriesRepresentative(allLegacy, undefined)?.id).toBe('gpt-5.4');
  });
});
