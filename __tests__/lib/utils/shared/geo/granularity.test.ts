import {
  areaVisibilityAtZoom,
  effectiveRadiusKm,
  featureGranularity,
  findDemotedAreaIds,
  isAreaFeature,
} from '@/lib/utils/shared/geo/granularity';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const feature = (overrides: Partial<MapFeature> = {}): MapFeature => ({
  id: 'f1',
  name: 'Goma',
  description: '',
  lat: -1.66,
  lon: 29.22,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
  ...overrides,
});

describe('featureGranularity / isAreaFeature', () => {
  it('treats legacy features as city points', () => {
    expect(featureGranularity(feature())).toBe('city');
    expect(isAreaFeature(feature())).toBe(false);
  });
  it('classifies district/region/country as areas', () => {
    expect(isAreaFeature(feature({ granularity: 'country' }))).toBe(true);
    expect(isAreaFeature(feature({ granularity: 'site' }))).toBe(false);
  });
});

describe('effectiveRadiusKm', () => {
  it('uses the model radius when sane', () => {
    expect(
      effectiveRadiusKm(
        feature({ granularity: 'country', approxRadiusKm: 400 }),
      ),
    ).toBe(400);
  });
  it('clamps absurd radii per class', () => {
    expect(
      effectiveRadiusKm(
        feature({ granularity: 'district', approxRadiusKm: 5000 }),
      ),
    ).toBe(100);
    expect(
      effectiveRadiusKm(feature({ granularity: 'country', approxRadiusKm: 1 })),
    ).toBe(50);
  });
  it('falls back to class defaults when missing', () => {
    expect(effectiveRadiusKm(feature({ granularity: 'region' }))).toBe(100);
    expect(effectiveRadiusKm(feature())).toBe(0); // points have no extent
  });
});

describe('areaVisibilityAtZoom', () => {
  const country = feature({ granularity: 'country' });
  it('is fully visible when zoomed out', () => {
    expect(areaVisibilityAtZoom(country, 4)).toBe(1);
  });
  it('fades past its scale and hides beyond it', () => {
    expect(areaVisibilityAtZoom(country, 6)).toBeLessThan(1);
    expect(areaVisibilityAtZoom(country, 6)).toBeGreaterThan(0);
    expect(areaVisibilityAtZoom(country, 8)).toBe(0);
  });
});

describe('findDemotedAreaIds', () => {
  it('demotes a country when a finer feature shares its country code', () => {
    const demoted = findDemotedAreaIds([
      feature({
        id: 'drc',
        name: 'Democratic Republic of the Congo',
        granularity: 'country',
        countryCode: 'CD',
      }),
      feature({ id: 'goma', granularity: 'city', countryCode: 'CD' }),
    ]);
    expect(demoted.has('drc')).toBe(true);
    expect(demoted.has('goma')).toBe(false);
  });

  it("demotes an area named as a finer feature's parent", () => {
    const demoted = findDemotedAreaIds([
      feature({ id: 'nk', name: 'North Kivu', granularity: 'region' }),
      feature({ id: 'goma', granularity: 'city', parentName: 'north kivu' }),
    ]);
    expect(demoted.has('nk')).toBe(true);
  });

  it('does not demote an area with no mapped contents', () => {
    const demoted = findDemotedAreaIds([
      feature({
        id: 'sy',
        name: 'Syria',
        granularity: 'country',
        countryCode: 'SY',
        prominence: 'mention',
      }),
      feature({ id: 'goma', granularity: 'city', countryCode: 'CD' }),
    ]);
    expect(demoted.size).toBe(0);
  });

  it('never demotes based on equal or coarser features', () => {
    const demoted = findDemotedAreaIds([
      feature({
        id: 'a',
        name: 'Venezuela',
        granularity: 'country',
        countryCode: 'VE',
      }),
      feature({
        id: 'b',
        name: 'Colombia',
        granularity: 'country',
        countryCode: 'CO',
      }),
    ]);
    expect(demoted.size).toBe(0);
  });
});
