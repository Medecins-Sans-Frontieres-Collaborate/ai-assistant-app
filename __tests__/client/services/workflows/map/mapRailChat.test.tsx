import { applyChatMutations } from '@/client/services/workflows/map/mapRailChat';

import { Conversation } from '@/types/chat';
import { MapWorkflowState } from '@/types/workflow';

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
      features: [
        {
          id: 'caracas',
          name: 'Caracas',
          description: '',
          lat: 10.48,
          lon: -66.9,
          confidence: 'high',
          confidenceReason: '',
          category: 'city',
        },
      ],
      sources: [],
      updatedAt: '2026-07-10T00:00:00.000Z',
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

const newFeature = {
  name: 'La Guaira',
  description: 'Epicenter',
  lat: 10.6,
  lon: -66.93,
  confidence: 'high' as const,
  confidenceReason: '',
  category: 'incident',
};

describe('applyChatMutations', () => {
  beforeEach(() => seedMapConversation());

  it('adds features with a chat source record', () => {
    const result = applyChatMutations('map-1', {
      features: [newFeature],
      connections: [],
    });
    expect(result).toMatchObject({ added: 1, connected: 0, capped: false });

    const state = mapState();
    expect(state.features).toHaveLength(2);
    expect(state.sources[0]).toMatchObject({ kind: 'chat', featureCount: 1 });
  });

  it('resolves connections against existing and new features', () => {
    const result = applyChatMutations('map-1', {
      features: [newFeature],
      connections: [
        {
          fromName: 'caracas',
          toName: 'La Guaira',
          kind: 'movement',
          description: 'Response travel',
        },
      ],
    });
    expect(result).toMatchObject({ added: 1, connected: 1, unresolved: 0 });

    const state = mapState();
    expect(state.connections).toHaveLength(1);
    expect(state.connections![0].fromId).toBe('caracas');
  });

  it('drops invalid coordinates and unresolved connections', () => {
    const result = applyChatMutations('map-1', {
      features: [{ ...newFeature, lat: 999 }],
      connections: [
        { fromName: 'Caracas', toName: 'Atlantis', kind: 'x', description: '' },
      ],
    });
    expect(result).toMatchObject({ added: 0, connected: 0, unresolved: 1 });
    expect(mapState().features).toHaveLength(1);
  });

  it('applies nothing when the feature cap would be exceeded', () => {
    seedMapConversation({
      features: Array.from({ length: 2000 }, (_, i) => ({
        id: `f${i}`,
        name: `F${i}`,
        description: '',
        lat: 1,
        lon: 1,
        confidence: 'high' as const,
        confidenceReason: '',
        category: 'x',
      })),
    });
    const result = applyChatMutations('map-1', {
      features: [newFeature],
      connections: [],
    });
    expect(result).toMatchObject({ capped: true, added: 0 });
    expect(mapState().features).toHaveLength(2000);
  });

  it('returns null and leaves state untouched for empty mutations', () => {
    const before = useConversationStore.getState().conversations;
    const result = applyChatMutations('map-1', {
      features: [],
      connections: [],
    });
    expect(result).toBeNull();
    expect(useConversationStore.getState().conversations).toBe(before);
  });
});
