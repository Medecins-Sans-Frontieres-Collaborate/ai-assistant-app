import { isValidCoordinate } from '@/lib/utils/shared/geo/geojson';
import { MAP_MAX_FEATURES } from '@/lib/utils/shared/geo/mapLimits';

import { MapConnection, MapFeature, MapWorkflowState } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';
import { v4 as uuidv4 } from 'uuid';

/** The payload served by GET /api/map-datasets/[id]. */
export interface LoadableMapDataset {
  id: string;
  name: string;
  description: string;
  features: MapFeature[];
  connections: MapConnection[];
  updatedAt: string;
}

/**
 * Snapshots an admin dataset into a map workspace (modeled on
 * applyChatMutations). The copy is a normal generation-run-shaped addition:
 * fresh feature ids (dataset ids stay stable dataset-side; a workspace must
 * never collide with another load or its own features), connection
 * endpoints remapped through the old→new id map, and one source record of
 * kind 'dataset' carrying the datasetId for provenance. Admin updates to
 * the dataset do NOT retroactively change loaded maps — users re-load for
 * updates.
 *
 * Returns null when the conversation has no map state; `capped: true` (and
 * writes NOTHING) when the load would exceed the workspace feature cap.
 */
export function loadDatasetIntoWorkspace(
  conversationId: string,
  dataset: LoadableMapDataset,
): { added: number; connected: number; capped: boolean } | null {
  const store = useConversationStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const state =
    conversation?.workflowState?.kind === 'map'
      ? (conversation.workflowState as MapWorkflowState)
      : undefined;
  if (!state) return null;

  const validFeatures = dataset.features.filter((f) =>
    isValidCoordinate(f.lat, f.lon),
  );
  if (state.features.length + validFeatures.length > MAP_MAX_FEATURES) {
    return { added: 0, connected: 0, capped: true };
  }

  const sourceId = uuidv4();
  const idMap = new Map<string, string>();
  const incoming: MapFeature[] = validFeatures.map((f) => {
    const newId = uuidv4();
    idMap.set(f.id, newId);
    return { ...f, id: newId, sourceId };
  });

  // Connections survive only when both endpoints made it through coordinate
  // validation — a half-dangling connection would break the layer renderer.
  const connections: MapConnection[] = dataset.connections.flatMap(
    (connection) => {
      const fromId = idMap.get(connection.fromId);
      const toId = idMap.get(connection.toId);
      if (!fromId || !toId) return [];
      return [{ ...connection, id: uuidv4(), fromId, toId, sourceId }];
    },
  );

  if (incoming.length === 0) return null;

  store.updateWorkflowState(conversationId, (prev) => {
    const p = prev as MapWorkflowState;
    return {
      ...p,
      features: [...p.features, ...incoming],
      connections: [...(p.connections ?? []), ...connections],
      sources: [
        ...p.sources,
        {
          id: sourceId,
          name: dataset.name,
          addedAt: new Date().toISOString(),
          featureCount: incoming.length,
          kind: 'dataset' as const,
          datasetId: dataset.id,
        },
      ],
      updatedAt: new Date().toISOString(),
    };
  });

  return {
    added: incoming.length,
    connected: connections.length,
    capped: false,
  };
}
