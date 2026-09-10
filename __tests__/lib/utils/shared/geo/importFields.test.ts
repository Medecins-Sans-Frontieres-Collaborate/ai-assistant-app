import {
  IMPORT_FIELDS,
  buildTemplateCsv,
  detectMapping,
  fieldForHeader,
  mappingHasRequired,
  missingRequired,
} from '@/lib/utils/shared/geo/importFields';

import { describe, expect, it } from 'vitest';

describe('import field vocabulary', () => {
  it('resolves headers case- and punctuation-insensitively', () => {
    expect(fieldForHeader('Latitude')).toBe('lat');
    expect(fieldForHeader('Country Code')).toBe('country_code');
    expect(fieldForHeader('COUNTRY-CODE')).toBe('country_code');
    expect(fieldForHeader('lng')).toBe('lon');
    expect(fieldForHeader('population')).toBeNull();
  });

  it('every alias is unique across fields', () => {
    const seen = new Map<string, string>();
    for (const field of IMPORT_FIELDS) {
      for (const alias of field.aliases) {
        expect(
          seen.get(alias),
          `alias "${alias}" claimed twice`,
        ).toBeUndefined();
        seen.set(alias, field.key);
      }
    }
  });

  it('detects a mapping, reports unknown headers, and flags ambiguity', () => {
    const detected = detectMapping([
      'Name',
      'lat',
      'Longitude',
      'y',
      'population',
    ]);
    expect(detected.mapping).toEqual({
      name: 'Name',
      lat: 'lat',
      lon: 'Longitude',
    });
    expect(detected.unmapped).toEqual(['population']);
    // "y" also means latitude; first header wins, the rest are a question.
    expect(detected.ambiguous).toEqual({ lat: ['y'] });
  });

  it('knows when the required fields are satisfied', () => {
    expect(mappingHasRequired({ name: 'n', lat: 'a', lon: 'b' })).toBe(true);
    expect(mappingHasRequired({ name: 'n', coordinates: 'c' })).toBe(true);
    expect(mappingHasRequired({ name: 'n', lat: 'a' })).toBe(false);
    expect(missingRequired({ lat: 'a' })).toEqual(['name', 'lon']);
    expect(missingRequired({ name: 'n', coordinates: 'c' })).toEqual([]);
    // Geometry files position every row themselves and number nameless ones.
    expect(mappingHasRequired({}, true)).toBe(true);
    expect(missingRequired({}, true)).toEqual([]);
  });

  it('builds a template the detector accepts without a mapping step', () => {
    const csv = buildTemplateCsv();
    const [header, example] = csv.trim().split('\n');
    const headers = header.split(',');
    expect(headers).not.toContain('coordinates');
    expect(mappingHasRequired(detectMapping(headers).mapping)).toBe(true);
    expect(detectMapping(headers).unmapped).toEqual([]);
    expect(example.split(',').length).toBeGreaterThanOrEqual(headers.length);
  });

  it('matches the CSV export header names', () => {
    // The round-trip contract: what the app exports, it imports unchanged.
    const exported = [
      'name',
      'lat',
      'lon',
      'category',
      'granularity',
      'country_code',
      'parent',
      'approx_radius_km',
      'event_start',
      'event_end',
      'event_precision',
      'event_ongoing',
      'prominence',
      'confidence',
      'confidence_reason',
      'description',
      'source',
      'source_url',
    ];
    const detected = detectMapping(exported);
    expect(detected.unmapped).toEqual([]);
    expect(Object.keys(detected.ambiguous)).toEqual([]);
  });
});
