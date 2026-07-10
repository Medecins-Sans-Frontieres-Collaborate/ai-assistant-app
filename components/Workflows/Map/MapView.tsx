'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  CircleMarker,
  MapContainer,
  Pane,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';

import {
  areaVisibilityAtZoom,
  effectiveRadiusKm,
  featureGranularity,
  isAreaFeature,
} from '@/lib/utils/shared/geo/granularity';

import {
  MapConnection,
  MapFeature,
  MapFeatureProminence,
} from '@/types/workflow';

import { ConnectionsLayer } from './ConnectionsLayer';

import 'leaflet/dist/leaflet.css';

/**
 * Raster tiles keep the map keyless and WebGL-free (field laptops). The
 * URL is env-configurable so deployments can point at a self-hosted or
 * proxied tile server — every tile request reveals the viewed area (z/x/y)
 * to the tile host, which matters for a privacy-first tool.
 */
const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Confidence → marker color/dash. Shape/dash varies too, not color alone. */
const CONFIDENCE_STYLE: Record<
  MapFeature['confidence'],
  { color: string; fillColor: string; dashArray?: string }
> = {
  high: { color: '#1d4ed8', fillColor: '#3b82f6' },
  medium: { color: '#b45309', fillColor: '#f59e0b', dashArray: '4 3' },
  low: { color: '#b91c1c', fillColor: '#f87171', dashArray: '2 4' },
};

/**
 * Prominence → marker weight. Passing mentions render small and faint so
 * an aside about a distant country doesn't read like a second theater of
 * operations. Features saved before prominence existed count as primary.
 */
const PROMINENCE_STYLE: Record<
  MapFeatureProminence,
  { radius: number; fillOpacity: number; weight: number }
> = {
  primary: { radius: 9, fillOpacity: 0.75, weight: 2 },
  secondary: { radius: 7, fillOpacity: 0.6, weight: 2 },
  mention: { radius: 5, fillOpacity: 0.35, weight: 1 },
};

export function featureProminence(feature: MapFeature): MapFeatureProminence {
  return feature.prominence ?? 'primary';
}

export interface MapFocus {
  id: string;
  /** Bumped per click so re-clicking the same feature re-centers. */
  nonce: number;
}

interface MapViewProps {
  features: MapFeature[];
  connections?: MapConnection[];
  /** Ids of container areas demoted to outline-only (see granularity.ts). */
  demotedIds: Set<string>;
  /** Ids rendered faint (undated features during a time-lapse sweep). */
  faintIds?: Set<string>;
  view?: { lat: number; lon: number; zoom: number };
  focus?: MapFocus | null;
  onViewChange?: (view: { lat: number; lon: number; zoom: number }) => void;
  onTileError?: () => void;
  confidenceLabel: (confidence: MapFeature['confidence']) => string;
  prominenceLabel: (prominence: MapFeatureProminence) => string;
  granularityLabel: (granularity: string) => string;
  /** Preformatted date line for the popup, or null when undated. */
  dateLabel: (feature: MapFeature) => string | null;
}

function FocusController({
  features,
  focus,
}: {
  features: MapFeature[];
  focus?: MapFocus | null;
}) {
  const map = useMap();
  useEffect(() => {
    if (!focus) return;
    const feature = features.find((f) => f.id === focus.id);
    if (!feature) return;
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    // Areas focus at a zoom that shows their extent, points zoom in close.
    const targetZoom = isAreaFeature(feature)
      ? Math.min(Math.max(map.getZoom(), 4), 7)
      : Math.max(map.getZoom(), 8);
    if (reducedMotion) {
      map.setView([feature.lat, feature.lon], targetZoom);
    } else {
      map.flyTo([feature.lat, feature.lon], targetZoom, { duration: 0.8 });
    }
    // `features` deliberately omitted: refetching the array (e.g. a feature
    // removed elsewhere) must not re-run the flight; only a new click does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, focus]);
  return null;
}

/**
 * First render without a saved view: frame the map around the places the
 * material is actually about. Passing mentions are excluded from the fit
 * so one faraway aside doesn't zoom the world out.
 */
function InitialBounds({
  features,
  hasSavedView,
}: {
  features: MapFeature[];
  hasSavedView: boolean;
}) {
  const map = useMap();
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current || hasSavedView || features.length === 0) return;
    doneRef.current = true;
    const core = features.filter((f) => featureProminence(f) !== 'mention');
    const target = core.length > 0 ? core : features;
    if (target.length === 1) {
      map.setView([target[0].lat, target[0].lon], 6);
      return;
    }
    map.fitBounds(
      target.map((f) => [f.lat, f.lon] as [number, number]),
      { padding: [40, 40], maxZoom: 10 },
    );
  }, [map, features, hasSavedView]);
  return null;
}

function ViewPersistence({
  onViewChange,
}: {
  onViewChange?: (view: { lat: number; lon: number; zoom: number }) => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (!onViewChange) return;
    const handler = () => {
      const center = map.getCenter();
      onViewChange({ lat: center.lat, lon: center.lng, zoom: map.getZoom() });
    };
    map.on('moveend', handler);
    return () => {
      map.off('moveend', handler);
    };
  }, [map, onViewChange]);
  return null;
}

function TileErrorListener({ onTileError }: { onTileError?: () => void }) {
  const map = useMap();
  useEffect(() => {
    if (!onTileError) return;
    map.on('tileerror', onTileError);
    return () => {
      map.off('tileerror', onTileError);
    };
  }, [map, onTileError]);
  return null;
}

function ZoomTracker({ onZoom }: { onZoom: (zoom: number) => void }) {
  const map = useMapEvents({
    zoomend: () => onZoom(map.getZoom()),
  });
  useEffect(() => {
    onZoom(map.getZoom());
  }, [map, onZoom]);
  return null;
}

interface FeatureLabels {
  confidenceLabel: (confidence: MapFeature['confidence']) => string;
  prominenceLabel: (prominence: MapFeatureProminence) => string;
  granularityLabel: (granularity: string) => string;
  dateLabel: (feature: MapFeature) => string | null;
}

function FeaturePopup({
  feature,
  labels,
}: {
  feature: MapFeature;
  labels: FeatureLabels;
}) {
  return (
    <Popup>
      <strong>{feature.name}</strong>
      {feature.description && (
        <>
          <br />
          {feature.description}
        </>
      )}
      <br />
      {labels.granularityLabel(featureGranularity(feature))}
      {' · '}
      {labels.prominenceLabel(featureProminence(feature))}
      {labels.dateLabel(feature) && (
        <>
          <br />
          {labels.dateLabel(feature)}
        </>
      )}
      <br />
      <em>
        {labels.confidenceLabel(feature.confidence)}
        {feature.confidenceReason ? ` — ${feature.confidenceReason}` : ''}
      </em>
    </Popup>
  );
}

/**
 * Point markers (sites/cities). Deliberately zoom-independent and
 * memoized: zoomend must not reconcile ~2000 CircleMarkers when zoom only
 * affects area circles.
 */
const PointMarkers = memo(function PointMarkers({
  features,
  faintIds,
  labels,
}: {
  features: MapFeature[];
  faintIds?: Set<string>;
  labels: FeatureLabels;
}) {
  return (
    <>
      {features.map((feature) => {
        const confidence =
          CONFIDENCE_STYLE[feature.confidence] ?? CONFIDENCE_STYLE.low;
        const prominence = PROMINENCE_STYLE[featureProminence(feature)];
        // Faint = undated features during a time-lapse sweep.
        const faintFactor = faintIds?.has(feature.id) ? 0.3 : 1;
        return (
          <CircleMarker
            key={feature.id}
            center={[feature.lat, feature.lon]}
            radius={prominence.radius}
            pathOptions={{
              color: confidence.color,
              fillColor: confidence.fillColor,
              fillOpacity: prominence.fillOpacity * faintFactor,
              opacity: faintFactor,
              weight: prominence.weight,
              dashArray: confidence.dashArray,
            }}
          >
            <FeaturePopup feature={feature} labels={labels} />
          </CircleMarker>
        );
      })}
    </>
  );
});

/**
 * Area extent circles (district/region/country); zoom-dependent fade.
 *
 * NON-INTERACTIVE by design: with the shared canvas renderer, click
 * priority follows draw order, and every incremental ingest appends its
 * new circles after previously-mounted point markers — a region added
 * later would swallow clicks on every point inside it. Extent circles
 * are "roughly this area" backdrop, so they take no pointer events at
 * all (points always win); their full details live in the sidebar list,
 * whose rows expand.
 */
const AreaCircles = memo(function AreaCircles({
  features,
  zoom,
  demotedIds,
  faintIds,
}: {
  features: MapFeature[];
  zoom: number;
  demotedIds: Set<string>;
  faintIds?: Set<string>;
}) {
  return (
    <>
      {features.map((feature) => {
        const visibility = areaVisibilityAtZoom(feature, zoom);
        if (visibility === 0) return null;
        const confidence =
          CONFIDENCE_STYLE[feature.confidence] ?? CONFIDENCE_STYLE.low;
        const demoted = demotedIds.has(feature.id);
        const mentionFactor =
          featureProminence(feature) === 'mention' ? 0.5 : 1;
        const faintFactor = faintIds?.has(feature.id) ? 0.3 : 1;
        const dimming = visibility * mentionFactor * faintFactor;
        return (
          <Circle
            key={feature.id}
            center={[feature.lat, feature.lon]}
            radius={effectiveRadiusKm(feature) * 1000}
            interactive={false}
            pathOptions={{
              color: confidence.color,
              fillColor: confidence.fillColor,
              // Demoted containers keep only an outline: their contents
              // are on the map as finer features already.
              fillOpacity: demoted ? 0 : 0.12 * dimming,
              opacity: (demoted ? 0.35 : 0.55) * dimming,
              weight: 1.5,
              dashArray: '6 6',
            }}
          />
        );
      })}
    </>
  );
});

/**
 * Leaflet map (client-only — the workspace imports this via next/dynamic
 * with ssr:false). Visual channels: color/dash = confidence, marker size/
 * opacity = prominence, geometry = granularity (points for sites/cities,
 * translucent extent circles for districts/regions/countries — honest
 * approximations, not boundaries; real polygons are future work, see
 * docs/MAP_WORKFLOW.md). Area circles fade out as the zoom passes their
 * scale; demoted container areas render as outline only. Canvas renderer
 * + the memoized point/area layer split keep ~2000 features usable on
 * low-end hardware.
 */
export default function MapView({
  features,
  connections,
  demotedIds,
  faintIds,
  view,
  focus,
  onViewChange,
  onTileError,
  confidenceLabel,
  prominenceLabel,
  granularityLabel,
  dateLabel,
}: MapViewProps) {
  const center: [number, number] = view
    ? [view.lat, view.lon]
    : features.length > 0
      ? [features[0].lat, features[0].lon]
      : [10, 10];
  const initialZoom = view?.zoom ?? (features.length > 0 ? 5 : 2);
  const [zoom, setZoom] = useState(initialZoom);

  const labels = useMemo<FeatureLabels>(
    () => ({ confidenceLabel, prominenceLabel, granularityLabel, dateLabel }),
    [confidenceLabel, prominenceLabel, granularityLabel, dateLabel],
  );

  // Passing mentions first so primary markers paint on top of them;
  // memoized so zoom changes don't re-sort.
  const { points, areas } = useMemo(() => {
    const rank = { mention: 0, secondary: 1, primary: 2 } as const;
    const ordered = [...features].sort(
      (a, b) => rank[featureProminence(a)] - rank[featureProminence(b)],
    );
    return {
      points: ordered.filter((f) => !isAreaFeature(f)),
      areas: ordered.filter(isAreaFeature),
    };
  }, [features]);

  return (
    <MapContainer
      center={center}
      zoom={initialZoom}
      className="h-full w-full"
      scrollWheelZoom
      // One shared canvas instead of ~2000 SVG nodes; applies to all
      // Path layers (CircleMarker/Circle/Polyline).
      preferCanvas
    >
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
      <InitialBounds features={features} hasSavedView={!!view} />
      <FocusController features={features} focus={focus} />
      <ViewPersistence onViewChange={onViewChange} />
      <TileErrorListener onTileError={onTileError} />
      <ZoomTracker onZoom={setZoom} />
      {connections && connections.length > 0 && (
        <ConnectionsLayer
          connections={connections}
          features={features}
          faintIds={faintIds}
        />
      )}
      {/*
        Dedicated pane BELOW the default overlay pane (zIndex 400):
        areas paint under points/connections regardless of mount order,
        and — being non-interactive — never intercept their clicks.
      */}
      <Pane name="map-area-circles" style={{ zIndex: 350 }}>
        <AreaCircles
          features={areas}
          zoom={zoom}
          demotedIds={demotedIds}
          faintIds={faintIds}
        />
      </Pane>
      <PointMarkers features={points} faintIds={faintIds} labels={labels} />
    </MapContainer>
  );
}
