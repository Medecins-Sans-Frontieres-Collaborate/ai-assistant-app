import { MapConnection, MapFeature } from '@/types/workflow';

/**
 * Resolution of model-reported, name-referenced connections into id-based
 * MapConnections, plus lifecycle helpers. Client-safe (no server imports).
 */

export interface NamedConnection {
  fromName: string;
  toName: string;
  kind: string;
  description: string;
}

function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

/**
 * Resolves fromName/toName case-insensitively against the given features
 * (callers pass incoming-run features first so same-run references win,
 * then existing features). Unresolved or self-referencing pairs are
 * dropped and counted.
 */
export function resolveConnections(
  named: NamedConnection[],
  features: MapFeature[],
  makeId: () => string,
  sourceId?: string,
): { connections: MapConnection[]; unresolved: number } {
  const byName = new Map<string, string>();
  // First occurrence wins; iterate in caller-provided priority order.
  for (const feature of features) {
    const key = nameKey(feature.name);
    if (key && !byName.has(key)) byName.set(key, feature.id);
  }

  const connections: MapConnection[] = [];
  let unresolved = 0;
  const seen = new Set<string>();

  for (const conn of named) {
    const fromId = byName.get(nameKey(conn.fromName));
    const toId = byName.get(nameKey(conn.toName));
    if (!fromId || !toId || fromId === toId) {
      unresolved += 1;
      continue;
    }
    // Dedupe identical pairs within one run (direction-sensitive).
    const dupeKey = `${fromId}→${toId}|${conn.kind.trim().toLowerCase()}`;
    if (seen.has(dupeKey)) continue;
    seen.add(dupeKey);

    connections.push({
      id: makeId(),
      fromId,
      toId,
      kind: conn.kind.trim(),
      description: conn.description.trim(),
      ...(sourceId ? { sourceId } : {}),
    });
  }

  return { connections, unresolved };
}

/** Drops connections referencing a removed feature. */
export function connectionsWithoutFeature(
  connections: MapConnection[],
  featureId: string,
): MapConnection[] {
  return connections.filter(
    (c) => c.fromId !== featureId && c.toId !== featureId,
  );
}
