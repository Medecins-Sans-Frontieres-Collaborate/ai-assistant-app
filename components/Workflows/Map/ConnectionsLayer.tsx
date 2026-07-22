'use client';

import { Polyline, Popup } from 'react-leaflet';

import { useTranslations } from 'next-intl';

import { MapConnection, MapFeature } from '@/types/workflow';

interface ConnectionsLayerProps {
  connections: MapConnection[];
  /** Features currently visible on the map (post filters/timeline). */
  features: MapFeature[];
  /** Ids rendered faint (undated during a time-lapse sweep). */
  faintIds?: Set<string>;
}

/**
 * Dashed polylines for stated relationships between features. A line only
 * renders while BOTH endpoints are visible, and dims when either endpoint
 * is faint — connections follow their events through filters and the time
 * lapse. Historical references render lighter/dotted so they don't read
 * as active links. Straight lines v1 (geodesic arcs deferred).
 */
export function ConnectionsLayer({
  connections,
  features,
  faintIds,
}: ConnectionsLayerProps) {
  const t = useTranslations('workflows');
  const byId = new Map(features.map((f) => [f.id, f]));

  return (
    <>
      {connections.map((connection) => {
        const from = byId.get(connection.fromId);
        const to = byId.get(connection.toId);
        if (!from || !to) return null;

        const isReference = /referen|histor|compar/i.test(connection.kind);
        const faint =
          faintIds?.has(connection.fromId) || faintIds?.has(connection.toId);
        const baseOpacity = isReference ? 0.35 : 0.6;

        return (
          <Polyline
            key={connection.id}
            positions={[
              [from.lat, from.lon],
              [to.lat, to.lon],
            ]}
            pathOptions={{
              color: '#4b5563',
              weight: isReference ? 1 : 1.5,
              opacity: faint ? baseOpacity * 0.4 : baseOpacity,
              dashArray: isReference ? '2 6' : '8 6',
            }}
          >
            <Popup>
              <strong>
                {t('map.connections.popupTitle', {
                  from: from.name,
                  to: to.name,
                })}
              </strong>
              <br />
              {t('map.connections.popupKind', { kind: connection.kind })}
              {connection.description && (
                <>
                  <br />
                  {connection.description}
                </>
              )}
            </Popup>
          </Polyline>
        );
      })}
    </>
  );
}
