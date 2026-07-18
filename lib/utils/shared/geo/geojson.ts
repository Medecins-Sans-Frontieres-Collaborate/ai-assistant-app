import { featureEventRange } from '@/lib/utils/shared/geo/eventTime';
import {
  buildSourceIndex,
  featureSource,
} from '@/lib/utils/shared/geo/featureSources';

import { MapConnection, MapFeature, MapSourceRecord } from '@/types/workflow';

/**
 * GeoJSON helpers for the map workflow: Point features plus LineString
 * features for connections. Exported GeoJSON is ArcGIS-compatible
 * (RFC 7946 FeatureCollection).
 */

export interface GeoJsonFeature {
  type: 'Feature';
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: [number, number][] };
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    // (0,0) is the classic hallucinated/unknown coordinate.
    !(lat === 0 && lon === 0)
  );
}

export function featuresToGeoJson(
  features: MapFeature[],
  connections: MapConnection[] = [],
  sources: MapSourceRecord[] = [],
): GeoJsonFeatureCollection {
  const valid = features.filter((f) => isValidCoordinate(f.lat, f.lon));
  const byId = new Map(valid.map((f) => [f.id, f]));
  const sourceIndex = buildSourceIndex(sources);

  const points: GeoJsonFeature[] = valid.map((f) => {
    const range = featureEventRange(f);
    const source = featureSource(f, sourceIndex);
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        // GeoJSON is [longitude, latitude]
        coordinates: [f.lon, f.lat] as [number, number],
      },
      properties: {
        name: f.name,
        description: f.description,
        confidence: f.confidence,
        confidenceReason: f.confidenceReason,
        category: f.category,
        prominence: f.prominence ?? 'primary',
        granularity: f.granularity ?? 'city',
        countryCode: f.countryCode ?? '',
        parentName: f.parentName ?? '',
        approxRadiusKm: f.approxRadiusKm ?? 0,
        eventStart: range?.start ?? '',
        eventEnd: range?.end ?? '',
        eventPrecision: range?.precision ?? '',
        eventOngoing: range?.ongoing ?? false,
        // Provenance travels with the export: a point nobody can trace back
        // to its material is not evidence.
        source: source?.name ?? '',
        sourceKind: source?.kind ?? '',
        sourceUrl: source?.url ?? '',
      },
    };
  });

  const lines: GeoJsonFeature[] = connections.flatMap((c) => {
    const from = byId.get(c.fromId);
    const to = byId.get(c.toId);
    if (!from || !to) return [];
    return [
      {
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [from.lon, from.lat] as [number, number],
            [to.lon, to.lat] as [number, number],
          ],
        },
        properties: {
          kind: c.kind,
          description: c.description,
          from: from.name,
          to: to.name,
        },
      },
    ];
  });

  return { type: 'FeatureCollection', features: [...points, ...lines] };
}
