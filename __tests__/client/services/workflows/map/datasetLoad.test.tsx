import {
  LoadableMapDataset,
  loadDatasetIntoWorkspace,
} from '@/client/services/workflows/map/datasetLoad';

import { MAP_MAX_FEATURES } from '@/lib/utils/shared/geo/mapLimits';

import { Conversation } from '@/types/chat';
import { MapFeature, MapWorkflowState } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it } from 'vitest';

function seedMapConversation(state: Partial<MapWorkflowState> = {}) {
  const conversation = {
    id: 'map-1',
    name: 'Map',
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.5,
    folderId: null,
    conversationType: 'map',
    workflowState: {
      kind: 'map',
      features: [],
      sources: [],
      updatedAt: '2026-07-23T00:00:00.000Z',
      ...state,
    },
  } as Conversation;
  useConversationStore.setState({
    conversations: [conversation],
    selectedConversationId: conversation.id,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function mapState(): MapWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as MapWorkflowState;
}

function datasetFeature(id: string, overrides: Partial<MapFeature> = {}) {
  return {
    id,
    name: `Place ${id}`,
    description: '',
    lat: 10,
    lon: 10,
    confidence: 'high' as const,
    confidenceReason: '',
    category: 'office',
    ...overrides,
  };
}

function makeDataset(
  overrides: Partial<LoadableMapDataset> = {},
): LoadableMapDataset {
  return {
    id: 'mapds-abc123def456',
    name: 'Sahel Presence',
    description: 'Ops presence',
    features: [datasetFeature('a'), datasetFeature('b', { lat: 11 })],
    connections: [
      {
        id: 'c1',
        fromId: 'a',
        toId: 'b',
        kind: 'supplies',
        description: '',
      },
    ],
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('loadDatasetIntoWorkspace', () => {
  beforeEach(() => seedMapConversation());

  it('snapshots features with fresh ids and remaps connection endpoints', () => {
    const result = loadDatasetIntoWorkspace('map-1', makeDataset());

    expect(result).toEqual({ added: 2, connected: 1, capped: false });
    const state = mapState();
    expect(state.features).toHaveLength(2);
    // Fresh ids — never the dataset's own.
    expect(state.features.map((f) => f.id)).not.toContain('a');
    // Topology preserved through the remap.
    const [connection] = state.connections ?? [];
    const byName = new Map(state.features.map((f) => [f.name, f.id]));
    expect(connection.fromId).toBe(byName.get('Place a'));
    expect(connection.toId).toBe(byName.get('Place b'));
  });

  it('records one dataset source with provenance', () => {
    loadDatasetIntoWorkspace('map-1', makeDataset());

    const [source] = mapState().sources;
    expect(source).toMatchObject({
      name: 'Sahel Presence',
      featureCount: 2,
      kind: 'dataset',
      datasetId: 'mapds-abc123def456',
    });
  });

  it('writes nothing when the load would exceed the workspace cap', () => {
    seedMapConversation({
      features: Array.from({ length: MAP_MAX_FEATURES - 1 }, (_, i) =>
        datasetFeature(`existing-${i}`),
      ),
    });

    const result = loadDatasetIntoWorkspace('map-1', makeDataset());

    expect(result).toEqual({ added: 0, connected: 0, capped: true });
    expect(mapState().features).toHaveLength(MAP_MAX_FEATURES - 1);
    expect(mapState().sources).toHaveLength(0);
  });

  it('drops connections whose endpoints failed coordinate validation', () => {
    const result = loadDatasetIntoWorkspace(
      'map-1',
      makeDataset({
        features: [
          datasetFeature('a'),
          datasetFeature('b', { lat: 999 }), // invalid → dropped
        ],
      }),
    );

    expect(result).toEqual({ added: 1, connected: 0, capped: false });
    expect(mapState().connections ?? []).toHaveLength(0);
  });

  it('returns null for a non-map conversation', () => {
    useConversationStore.setState({ conversations: [] });
    expect(loadDatasetIntoWorkspace('map-1', makeDataset())).toBeNull();
  });
});
