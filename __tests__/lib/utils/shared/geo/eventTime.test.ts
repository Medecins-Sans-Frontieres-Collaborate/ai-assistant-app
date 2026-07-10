import {
  featureVerdictAt,
  formatFeatureDates,
} from '@/lib/utils/shared/geo/eventTime';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const feature = (overrides: Partial<MapFeature> = {}): MapFeature => ({
  id: 'f1',
  name: 'Goma',
  description: '',
  lat: 1,
  lon: 1,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
  ...overrides,
});

const T = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

describe('featureVerdictAt (hybrid semantics)', () => {
  it('undated features are undated', () => {
    expect(featureVerdictAt(feature(), T('2026-06-01'))).toBe('undated');
  });

  it('point events persist after appearing', () => {
    const f = feature({ eventStart: '2026-03-12' });
    expect(featureVerdictAt(f, T('2026-03-11'))).toBe('inactive');
    expect(featureVerdictAt(f, T('2026-03-12'))).toBe('active');
    expect(featureVerdictAt(f, T('2026-12-01'))).toBe('active');
  });

  it('ranged events end when the material says so', () => {
    const f = feature({ eventStart: '2026-01', eventEnd: '2026-03' });
    expect(featureVerdictAt(f, T('2026-02-15'))).toBe('active');
    expect(featureVerdictAt(f, T('2026-04-01'))).toBe('inactive');
  });

  it('ongoing events persist past any end guess', () => {
    const f = feature({ eventStart: '2026-01', eventOngoing: true });
    expect(featureVerdictAt(f, T('2030-01-01'))).toBe('active');
  });

  it('precision widening favors visibility on both ends', () => {
    const f = feature({ eventStart: '2026', eventEnd: '2026' });
    // Active through the whole year, inclusive of its last day…
    expect(featureVerdictAt(f, T('2026-12-31'))).toBe('active');
    expect(featureVerdictAt(f, T('2026-01-01'))).toBe('active');
    // …but not outside it.
    expect(featureVerdictAt(f, T('2027-01-02'))).toBe('inactive');
    expect(featureVerdictAt(f, T('2025-12-31'))).toBe('inactive');
  });
});

describe('formatFeatureDates', () => {
  const t = (key: string, values?: Record<string, string>) => {
    if (key === 'dates.since') return `since ${values?.date}`;
    if (key === 'dates.range') return `${values?.start} – ${values?.end}`;
    if (key === 'dates.ongoing') return 'Ongoing';
    return key;
  };

  it('is null for undated (legacy) features', () => {
    expect(formatFeatureDates(feature(), 'en', t)).toBeNull();
  });

  it('formats a single date at its precision', () => {
    expect(formatFeatureDates(feature({ eventStart: '2026' }), 'en', t)).toBe(
      '2026',
    );
    expect(
      formatFeatureDates(feature({ eventStart: '2026-03' }), 'en', t),
    ).toMatch(/Mar/);
  });

  it('formats ongoing as "since"', () => {
    expect(
      formatFeatureDates(
        feature({ eventStart: '2026-03', eventOngoing: true }),
        'en',
        t,
      ),
    ).toMatch(/^since /);
  });

  it('formats ranges and dedupes equal endpoints', () => {
    expect(
      formatFeatureDates(
        feature({ eventStart: '2026-01', eventEnd: '2026-03' }),
        'en',
        t,
      ),
    ).toContain('–');
    expect(
      formatFeatureDates(
        feature({ eventStart: '2026-03', eventEnd: '2026-03' }),
        'en',
        t,
      ),
    ).not.toContain('–');
  });

  it('shows Ongoing when only the flag is set', () => {
    expect(formatFeatureDates(feature({ eventOngoing: true }), 'en', t)).toBe(
      'Ongoing',
    );
  });
});
