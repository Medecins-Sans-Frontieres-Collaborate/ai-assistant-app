import {
  buildEventRange,
  buildImport,
  parseCoordinatesCell,
  parseDateCell,
  parseNumberCell,
} from '@/lib/utils/shared/geo/importBuild';
import { detectMapping } from '@/lib/utils/shared/geo/importFields';
import {
  ParsedImport,
  parseDelimited,
} from '@/lib/utils/shared/geo/importParse';

import { describe, expect, it } from 'vitest';

function build(
  csv: string,
  extra: Partial<Parameters<typeof buildImport>[1]> = {},
) {
  const parsed = parseDelimited(csv, 'csv');
  return buildImport(parsed, {
    mapping: detectMapping(parsed.headers).mapping,
    defaultConfidence: 'high',
    sourceName: 'sites.csv',
    ...extra,
  });
}

describe('cell parsing', () => {
  it('reads numbers with a decimal comma and refuses junk', () => {
    expect(parseNumberCell('1,5')).toBe(1.5);
    expect(parseNumberCell(' -1.66 ')).toBe(-1.66);
    expect(parseNumberCell('N/A')).toBeNull();
    expect(parseNumberCell('1.234.567')).toBeNull();
  });

  it('reads a combined coordinates cell in its three shapes, lat-first for plain pairs', () => {
    expect(parseCoordinatesCell('-1.6585, 29.2205')).toEqual([
      29.2205, -1.6585,
    ]);
    expect(parseCoordinatesCell('POINT(29.2205 -1.6585)')).toEqual([
      29.2205, -1.6585,
    ]);
    expect(
      parseCoordinatesCell('{"type":"Point","coordinates":[29.2205,-1.6585]}'),
    ).toEqual([29.2205, -1.6585]);
    expect(parseCoordinatesCell('somewhere')).toBeNull();
  });
});

describe('dates', () => {
  it('takes precision from the shape of a partial date', () => {
    expect(parseDateCell('2024')?.precision).toBe('year');
    expect(parseDateCell('2024-03')?.precision).toBe('month');
    expect(parseDateCell('2024-03-12')?.precision).toBe('day');
    expect(parseDateCell('2024-03-12T14:30:00Z')).toEqual({
      instant: '2024-03-12T14:30',
      precision: 'minute',
      exclusiveEnd: '2024-03-12T14:31',
    });
  });

  it('refuses ambiguous numeric dates rather than guessing', () => {
    expect(parseDateCell('12/03/2024')).toBeNull();
  });

  it('builds a range, coarser of the two precisions, ongoing only without an end', () => {
    const range = buildEventRange('2024-03-12', '2024-04', '', 'yes');
    expect(range).toMatchObject({
      start: '2024-03-12T00:00',
      precision: 'month',
    });
    expect(range?.end).toBe('2024-05-01T00:00');
    expect(range?.ongoing).toBeUndefined();
    expect(buildEventRange('2024', '', '', 'true')).toMatchObject({
      ongoing: true,
    });
  });

  it('distinguishes no timing from unreadable timing', () => {
    expect(buildEventRange('', '', '', '')).toBeUndefined();
    expect(buildEventRange('soon', '', '', '')).toBeNull();
  });
});

describe('buildImport', () => {
  it('imports a clean row with defaults applied', () => {
    const result = build('name,lat,lon\nGoma,-1.6585,29.2205\n');
    expect(result.stats.imported).toBe(1);
    expect(result.features[0]).toMatchObject({
      name: 'Goma',
      lat: -1.6585,
      lon: 29.2205,
      confidence: 'high',
      confidenceReason: 'Imported from sites.csv',
      granularity: 'site',
      prominence: 'primary',
      approxRadiusKm: 0,
    });
  });

  it('swaps a pair only when one reading is impossible, and counts it', () => {
    // 120 cannot be a latitude but can be a longitude: unambiguous.
    const swapped = build('name,lat,lon\nSite,120,-1.6585\n');
    expect(swapped.features[0]).toMatchObject({ lat: -1.6585, lon: 120 });
    expect(swapped.stats.swapped).toBe(1);
    // Both readings are valid positions: never swapped, the file is trusted.
    const plausible = build('name,lat,lon\nGoma,29.2205,-1.6585\n');
    expect(plausible.features[0]).toMatchObject({ lat: 29.2205, lon: -1.6585 });
    expect(plausible.stats.swapped).toBe(0);
  });

  it('refuses projected coordinates rather than plotting them in the sea', () => {
    const result = build('name,lat,lon\nSite,4567890,345678\n');
    expect(result.features).toHaveLength(0);
    expect(result.stats.skipped.projected_coordinates).toBe(1);
  });

  it('skips rows without coordinates and counts why', () => {
    const result = build('name,lat,lon\nA,,\nB,1,2\n');
    expect(result.stats.imported).toBe(1);
    expect(result.skipped).toEqual([{ rowIndex: 1, reason: 'no_coordinates' }]);
  });

  it('skips exact duplicates of existing features by name AND position', () => {
    const result = build(
      'name,lat,lon\nGoma,-1.6585,29.2205\nGoma,-1.9,29.3\n',
      {
        existing: [{ name: 'goma', lat: -1.6585, lon: 29.2205 }],
      },
    );
    // Same name, different place: kept — two clinics can share a name.
    expect(result.stats.skipped.duplicate).toBe(1);
    expect(result.features.map((f) => f.lat)).toEqual([-1.9]);
  });

  it('numbers nameless rows and drops out-of-vocabulary optionals', () => {
    const result = build(
      'name,lat,lon,confidence,granularity\n,1,2,certain,huge\n',
    );
    expect(result.features[0].name).toBe('Point 1');
    expect(result.stats.unnamed).toBe(1);
    expect(result.features[0].confidence).toBe('high');
    expect(result.stats.droppedValues).toBe(2);
  });

  it('stops at capacity and counts the rest as capped', () => {
    const result = build('name,lat,lon\nA,1,2\nB,3,4\nC,5,6\n', {
      capacity: 2,
    });
    expect(result.stats.imported).toBe(2);
    expect(result.stats.skipped.capped).toBe(1);
  });

  it('reports headers it did not read', () => {
    const result = build('name,lat,lon,population\nA,1,2,300\n');
    expect(result.stats.ignoredHeaders).toEqual(['population']);
  });

  it('positions area geometry at its centre as an extent, not a pin', () => {
    const parsed: ParsedImport = {
      format: 'geojson',
      headers: ['name'],
      rows: [
        {
          index: 1,
          values: { name: 'Zone' },
          lonLat: [29.5, -1.5],
          geometry: 'area',
          radiusKm: 78.4,
        },
      ],
      connections: [],
      notes: [],
    };
    const result = buildImport(parsed, {
      mapping: { name: 'name' },
      defaultConfidence: 'medium',
      sourceName: 'zones.geojson',
    });
    expect(result.features[0]).toMatchObject({
      granularity: 'region',
      approxRadiusKm: 78.4,
      confidence: 'medium',
    });
    expect(result.stats.approximated).toBe(1);
  });

  it('prefers the row confidence over the default and reads event columns', () => {
    const result = build(
      'name,lat,lon,confidence,event_start,event_end,country_code\nA,1,2,low,2024-03,2024-04,cd\n',
    );
    expect(result.features[0].confidence).toBe('low');
    expect(result.features[0].event).toMatchObject({
      start: '2024-03-01T00:00',
      precision: 'month',
    });
    expect(result.features[0].countryCode).toBe('CD');
  });
});
