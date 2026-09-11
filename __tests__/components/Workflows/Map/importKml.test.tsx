import { parseKml } from '@/lib/utils/shared/geo/importParse';

import { describe, expect, it } from 'vitest';

/** Needs DOMParser, hence a jsdom test rather than a node one. */
const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Folder>
      <Placemark>
        <name>Goma</name>
        <description>Field hospital</description>
        <TimeSpan><begin>2024-03</begin><end>2024-05</end></TimeSpan>
        <ExtendedData><Data name="category"><value>health</value></Data></ExtendedData>
        <Point><coordinates>29.2205,-1.6585,0</coordinates></Point>
      </Placemark>
      <Placemark>
        <name>Zone</name>
        <Polygon><outerBoundaryIs><LinearRing>
          <coordinates>29,-2,0 30,-2,0 30,-1,0 29,-1,0 29,-2,0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

describe('parseKml', () => {
  it('reads placemarks, extended data and time spans; areas become centres', () => {
    const parsed = parseKml(KML);
    expect(parsed.format).toBe('kml');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      lonLat: [29.2205, -1.6585],
      geometry: 'point',
      values: {
        name: 'Goma',
        description: 'Field hospital',
        category: 'health',
        event_start: '2024-03',
        event_end: '2024-05',
      },
    });
    expect(parsed.rows[1]).toMatchObject({
      geometry: 'area',
      lonLat: [29.5, -1.5],
    });
    expect(parsed.headers).toEqual(
      expect.arrayContaining(['category', 'event_start', 'event_end']),
    );
    expect(parsed.notes).toEqual([{ kind: 'kml_folders_flattened' }]);
  });

  it('refuses malformed XML', () => {
    expect(() => parseKml('<kml><Placemark>')).toThrow();
  });
});
