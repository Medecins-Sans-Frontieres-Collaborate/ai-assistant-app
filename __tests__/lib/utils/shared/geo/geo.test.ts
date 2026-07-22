import {
  featuresToGeoJson,
  isValidCoordinate,
} from '@/lib/utils/shared/geo/geojson';
import { featuresToKml } from '@/lib/utils/shared/geo/kml';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const feature = (overrides: Partial<MapFeature> = {}): MapFeature => ({
  id: 'f1',
  name: 'Goma',
  description: 'Field hospital site',
  lat: -1.6585,
  lon: 29.2205,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
  ...overrides,
});

describe('isValidCoordinate', () => {
  it('accepts real coordinates', () => {
    expect(isValidCoordinate(-1.66, 29.22)).toBe(true);
  });
  it('rejects out-of-range values', () => {
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
  });
  it('rejects the (0,0) hallucination point', () => {
    expect(isValidCoordinate(0, 0)).toBe(false);
  });
  it('rejects non-numbers', () => {
    expect(isValidCoordinate('12', 5)).toBe(false);
    expect(isValidCoordinate(NaN, 5)).toBe(false);
  });
});

describe('featuresToGeoJson', () => {
  it('produces lon-lat point features', () => {
    const fc = featuresToGeoJson([feature()]);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features[0].geometry.coordinates).toEqual([29.2205, -1.6585]);
    expect(fc.features[0].properties.name).toBe('Goma');
  });

  it('carries prominence, defaulting legacy features to primary', () => {
    const fc = featuresToGeoJson([
      feature(),
      feature({ id: 'f2', name: 'Damascus', prominence: 'mention' }),
    ]);
    expect(fc.features[0].properties.prominence).toBe('primary');
    expect(fc.features[1].properties.prominence).toBe('mention');
  });

  it('drops invalid coordinates', () => {
    const fc = featuresToGeoJson([feature({ lat: 999 })]);
    expect(fc.features).toHaveLength(0);
  });
});

describe('featuresToKml', () => {
  it('serializes placemarks with escaped XML', () => {
    const kml = featuresToKml([
      feature({ name: 'Camp <A> & "B"', description: '' }),
    ]);
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(kml).toContain('Camp &lt;A&gt; &amp; &quot;B&quot;');
    expect(kml).toContain('<coordinates>29.2205,-1.6585,0</coordinates>');
    expect(kml).not.toContain('Camp <A>');
  });

  it('includes confidence in the description', () => {
    const kml = featuresToKml([
      feature({ confidence: 'low', confidenceReason: 'several towns named X' }),
    ]);
    expect(kml).toContain('Confidence: low (several towns named X)');
  });

  it('includes prominence in the description', () => {
    const kml = featuresToKml([feature({ prominence: 'mention' })]);
    expect(kml).toContain('Prominence: mention');
  });
});
