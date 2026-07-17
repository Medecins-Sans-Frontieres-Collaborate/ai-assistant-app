import { MapConnection, MapFeature } from '@/types/workflow';

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
): string {
  const valid = features.filter((f) => isValidCoordinate(f.lat, f.lon));
  const byId = new Map(valid.map((f) => [f.id, f]));

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
      const description = [
        f.description,
        f.category ? `Category: ${f.category}` : '',
        `Granularity: ${f.granularity ?? 'city'}${f.parentName ? ` (in ${f.parentName})` : ''}`,
        f.eventStart || f.eventEnd || f.eventOngoing
          ? `Dates: ${f.eventStart ?? ''}${f.eventEnd ? ` to ${f.eventEnd}` : ''}${f.eventOngoing ? ' (ongoing)' : ''}`.trim()
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
