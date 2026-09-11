import {
  ImportParseError,
  parseDelimited,
  parseGeoJson,
  parseJsonRows,
  sniffImportFormat,
} from '@/lib/utils/shared/geo/importParse';

import { describe, expect, it } from 'vitest';

describe('sniffImportFormat', () => {
  it('recognises GeoJSON by content whatever the extension', () => {
    expect(
      sniffImportFormat('x.json', '{"type":"FeatureCollection","features":[]}'),
    ).toBe('geojson');
    expect(
      sniffImportFormat('x.txt', ' {"type": "Point", "coordinates": [1,2]}'),
    ).toBe('geojson');
  });

  it('treats an array of objects as tabular JSON and other JSON as not an import', () => {
    expect(sniffImportFormat('rows.json', '[{"name":"a"}]')).toBe('json');
    expect(sniffImportFormat('config.json', '{"setting": true}')).toBeNull();
  });

  it('recognises KML and delimited text', () => {
    expect(sniffImportFormat('a.kml', '<?xml version="1.0"?><kml>')).toBe(
      'kml',
    );
    expect(sniffImportFormat('a.csv', 'name,lat,lon')).toBe('csv');
    expect(
      sniffImportFormat(undefined, 'name\tlatitude\tlongitude\nA\t1\t2'),
    ).toBe('tsv');
    expect(
      sniffImportFormat(undefined, 'Just some prose about Goma.'),
    ).toBeNull();
  });
});

describe('parseGeoJson', () => {
  it('turns points into positioned rows with their properties as columns', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [29.2205, -1.6585] },
            properties: { name: 'Goma', category: 'city', nested: { a: 1 } },
          },
        ],
      }),
    );
    expect(parsed.format).toBe('geojson');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].lonLat).toEqual([29.2205, -1.6585]);
    expect(parsed.rows[0].geometry).toBe('point');
    expect(parsed.rows[0].values).toEqual({ name: 'Goma', category: 'city' });
    expect(parsed.headers).toEqual(['name', 'category']);
  });

  it('reduces a polygon to its centre with a covering radius, and says so', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [29, -2],
              [30, -2],
              [30, -1],
              [29, -1],
              [29, -2],
            ],
          ],
        },
        properties: { name: 'Zone' },
      }),
    );
    const row = parsed.rows[0];
    expect(row.geometry).toBe('area');
    expect(row.lonLat).toEqual([29.5, -1.5]);
    expect(row.radiusKm).toBeGreaterThan(70);
  });

  it('expands a MultiPoint into numbered rows', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'MultiPoint',
          coordinates: [
            [1, 2],
            [3, 4],
          ],
        },
        properties: { name: 'Camp' },
      }),
    );
    expect(parsed.rows.map((r) => r.values.name)).toEqual([
      'Camp (1)',
      'Camp (2)',
    ]);
  });

  it('reads our own exported connections back as connections', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [1, 2],
                [3, 4],
              ],
            },
            properties: {
              fromName: 'A',
              toName: 'B',
              kind: 'supply',
              description: '',
            },
          },
        ],
      }),
    );
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.connections).toEqual([
      { fromName: 'A', toName: 'B', kind: 'supply', description: '' },
    ]);
  });

  it('keeps a feature without geometry as a row so the skip can be counted', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: null, properties: { name: 'Nowhere' } },
        ],
      }),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].lonLat).toBeUndefined();
  });

  it('lifts a feature id into the row when properties carry no name', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'Feature',
        id: 'site-7',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: {},
      }),
    );
    expect(parsed.rows[0].values.id).toBe('site-7');
  });

  it('refuses non-GeoJSON', () => {
    expect(() => parseGeoJson('{"setting": true}')).toThrow(ImportParseError);
    expect(() => parseGeoJson('not json')).toThrow(ImportParseError);
  });
});

describe('parseDelimited / parseJsonRows', () => {
  it('keeps cells as strings and reports headers in file order', () => {
    const parsed = parseDelimited(
      'Name,Lat,Lon\nGoma,-1.6585,29.2205\n',
      'csv',
    );
    expect(parsed.headers).toEqual(['Name', 'Lat', 'Lon']);
    expect(parsed.rows[0].values).toEqual({
      Name: 'Goma',
      Lat: '-1.6585',
      Lon: '29.2205',
    });
    expect(parsed.rows[0].index).toBe(1);
  });

  it('reads TSV', () => {
    const parsed = parseDelimited('name\tlat\tlon\nA\t1\t2', 'tsv');
    expect(parsed.rows[0].values).toEqual({ name: 'A', lat: '1', lon: '2' });
  });

  it('reads a JSON array of objects and ignores nested values', () => {
    const parsed = parseJsonRows(
      '[{"name":"A","lat":1,"lon":2,"meta":{"x":1}}]',
    );
    expect(parsed.rows[0].values).toEqual({ name: 'A', lat: 1, lon: 2 });
  });

  it('rejects an empty file', () => {
    expect(() => parseDelimited('   ', 'csv')).toThrow(ImportParseError);
  });
});
