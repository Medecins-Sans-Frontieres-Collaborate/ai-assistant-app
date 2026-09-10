/**
 * Small geometry helpers for turning non-point shapes into something the map
 * can show honestly. The map renders points and extent circles only, so an
 * area or a line becomes its centroid plus a radius that covers it — an
 * approximation the import summary always says out loud.
 *
 * Client-safe: pure arithmetic.
 */

export type LonLat = [number, number];

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LonLat, b: LonLat): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Centre and covering radius of a set of positions: the bounding box's
 * centre, and the distance from it to the farthest position. Chosen over an
 * area-weighted centroid because it is what the extent circle needs — the
 * circle must contain the shape, and a weighted centre of a long thin
 * polygon would sit inside it while leaving its ends uncovered.
 *
 * Positions straddling the antimeridian are not special-cased; a shape
 * crossing it gets a radius spanning the globe, which the summary reports as
 * an area rather than mislocating it.
 */
export function boundingCentre(
  positions: readonly LonLat[],
): { lon: number; lat: number; radiusKm: number } | null {
  const valid = positions.filter(
    ([lon, lat]) =>
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180,
  );
  if (valid.length === 0) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of valid) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const centre: LonLat = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  let radiusKm = 0;
  for (const p of valid) radiusKm = Math.max(radiusKm, haversineKm(centre, p));
  return { lon: centre[0], lat: centre[1], radiusKm };
}

/** Recursively flattens any GeoJSON coordinate nesting to a list of positions. */
export function flattenPositions(coordinates: unknown): LonLat[] {
  if (!Array.isArray(coordinates)) return [];
  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    return [[coordinates[0], coordinates[1]]];
  }
  return coordinates.flatMap((c) => flattenPositions(c));
}
