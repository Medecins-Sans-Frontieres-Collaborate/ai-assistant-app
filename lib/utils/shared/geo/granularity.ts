import { MapFeature, MapFeatureGranularity } from '@/types/workflow';

/**
 * Granularity model for the map workflow.
 *
 * A centroid pin for "Venezuela" and a pin for a specific field hospital
 * mean very different things. Site/city features render as point markers;
 * district/region/country features render as translucent extent circles
 * (approximations, deliberately fuzzy) so the map doesn't claim false
 * precision. True boundary polygons (bundled Natural Earth admin-0) are
 * planned follow-up work — see docs/MAP_WORKFLOW.md.
 */

export const GRANULARITY_RANK: Record<MapFeatureGranularity, number> = {
  site: 0,
  city: 1,
  district: 2,
  region: 3,
  country: 4,
};

interface AreaDisplaySpec {
  /** Fallback extent radius when the model gives none/nonsense. */
  defaultKm: number;
  minKm: number;
  maxKm: number;
  /** Map zoom at which the circle starts fading (its scale is passed). */
  fadeZoom: number;
  /** Map zoom at which the circle disappears entirely. */
  hideZoom: number;
}

export const AREA_DISPLAY: Partial<
  Record<MapFeatureGranularity, AreaDisplaySpec>
> = {
  district: { defaultKm: 25, minKm: 5, maxKm: 100, fadeZoom: 10, hideZoom: 12 },
  region: { defaultKm: 100, minKm: 20, maxKm: 500, fadeZoom: 8, hideZoom: 10 },
  country: { defaultKm: 300, minKm: 50, maxKm: 2000, fadeZoom: 6, hideZoom: 8 },
};

export function featureGranularity(feature: MapFeature): MapFeatureGranularity {
  // Features saved before granularity existed behave like the old point
  // markers.
  return feature.granularity ?? 'city';
}

export function isAreaFeature(feature: MapFeature): boolean {
  return featureGranularity(feature) in AREA_DISPLAY;
}

/** Clamped extent radius (km) for an area feature. */
export function effectiveRadiusKm(feature: MapFeature): number {
  const spec = AREA_DISPLAY[featureGranularity(feature)];
  if (!spec) return 0;
  const raw = feature.approxRadiusKm;
  const base =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? raw
      : spec.defaultKm;
  return Math.min(Math.max(base, spec.minKm), spec.maxKm);
}

/** 1 = fully visible, 0 = hidden; fades between fadeZoom and hideZoom. */
export function areaVisibilityAtZoom(
  feature: MapFeature,
  zoom: number,
): number {
  const spec = AREA_DISPLAY[featureGranularity(feature)];
  if (!spec) return 1;
  if (zoom < spec.fadeZoom) return 1;
  if (zoom >= spec.hideZoom) return 0;
  return 0.35;
}

/**
 * Containment demotion: when a run maps both "Goma" and "DRC", the country
 * feature is a container, not a finding — render it as outline only.
 * An area is demoted when a finer-grained feature links to it, either by
 * parentName (any area) or by shared country code (countries).
 */
export function findDemotedAreaIds(features: MapFeature[]): Set<string> {
  const demoted = new Set<string>();
  for (const area of features) {
    const granularity = featureGranularity(area);
    if (!(granularity in AREA_DISPLAY)) continue;
    const areaRank = GRANULARITY_RANK[granularity];
    const areaName = area.name.trim().toLowerCase();
    const areaCountry = area.countryCode?.trim().toUpperCase();

    const hasFinerChild = features.some((f) => {
      if (f.id === area.id) return false;
      if (GRANULARITY_RANK[featureGranularity(f)] >= areaRank) return false;
      if (f.parentName?.trim().toLowerCase() === areaName) return true;
      if (granularity === 'country' && areaCountry) {
        return f.countryCode?.trim().toUpperCase() === areaCountry;
      }
      return false;
    });
    if (hasFinerChild) demoted.add(area.id);
  }
  return demoted;
}
