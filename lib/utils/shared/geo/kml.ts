import { featureEventRange } from '@/lib/utils/shared/geo/eventTime';
import {
  buildSourceIndex,
  featureSource,
} from '@/lib/utils/shared/geo/featureSources';

import { MapConnection, MapFeature, MapSourceRecord } from '@/types/workflow';

import { isValidCoordinate } from './geojson';

/**
 * Minimal KML serializer for point placemarks — a ~60-line template beats
 * a dependency for this shape. Compatible with ArcGIS ("KML To Layer"),
 * Google Earth, and QGIS.
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function featuresToKml(
  features: MapFeature[],
  documentName = 'Locations',
  connections: MapConnection[] = [],
  sources: MapSourceRecord[] = [],
): string {
  const valid = features.filter((f) => isValidCoordinate(f.lat, f.lon));
  const byId = new Map(valid.map((f) => [f.id, f]));
  const sourceIndex = buildSourceIndex(sources);

  const linePlacemarks = connections
    .flatMap((c) => {
      const from = byId.get(c.fromId);
      const to = byId.get(c.toId);
      if (!from || !to) return [];
      return [
        `    <Placemark>
      <name>${escapeXml(`${from.name} → ${to.name}`)}</name>
      <description>${escapeXml(`${c.kind}${c.description ? `: ${c.description}` : ''}`)}</description>
      <LineString>
        <coordinates>${from.lon},${from.lat},0 ${to.lon},${to.lat},0</coordinates>
      </LineString>
    </Placemark>`,
      ];
    })
    .join('\n');

  const placemarks = valid
    .map((f) => {
      const range = featureEventRange(f);
      const source = featureSource(f, sourceIndex);
      const description = [
        f.description,
        f.category ? `Category: ${f.category}` : '',
        `Granularity: ${f.granularity ?? 'city'}${f.parentName ? ` (in ${f.parentName})` : ''}`,
        range
          ? `Dates: ${range.start}${range.end ? ` to ${range.end}` : ''}${range.ongoing ? ' (ongoing)' : ''} [${range.precision} precision]`
          : '',
        source
          ? `Source: ${source.name}${source.url ? ` (${source.url})` : ''}`
          : '',
        `Prominence: ${f.prominence ?? 'primary'}`,
        `Confidence: ${f.confidence}${f.confidenceReason ? ` (${f.confidenceReason})` : ''}`,
      ]
        .filter(Boolean)
        .join('\n');
      return `    <Placemark>
      <name>${escapeXml(f.name)}</name>
      <description>${escapeXml(description)}</description>
      <Point>
        <coordinates>${f.lon},${f.lat},0</coordinates>
      </Point>
    </Placemark>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(documentName)}</name>
${placemarks}${linePlacemarks ? `\n${linePlacemarks}` : ''}
  </Document>
</kml>
`;
}
