import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Conversation } from '@/types/chat';
import { MapWorkflowState } from '@/types/workflow';

import { MapWorkspace } from '@/components/Workflows/Map/MapWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A structured file lands on the map WITHOUT a model call — that is the whole
 * point of importing rather than extracting.
 */

const extractMapFeatures = vi.hoisted(() => vi.fn());
vi.mock('@/client/services/workflows/map/mapExtraction', () => ({
  extractMapFeatures,
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('@/client/hooks/settings/useAvailableMapDatasets', () => ({
  useAvailableMapDatasets: () => ({ datasets: [], isLoading: false }),
}));
// Leaflet has no place in jsdom; the map canvas is not what is under test.
vi.mock('@/components/Workflows/Map/MapView', () => ({
  default: () => <div data-testid="map-view" />,
  MapView: () => <div data-testid="map-view" />,
}));

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [29.2205, -1.6585] },
      properties: { name: 'Goma', category: 'city' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [28.8628, -2.5083] },
      properties: { name: 'Bukavu', category: 'city' },
    },
  ],
});

function seed() {
  const workflowState: MapWorkflowState = {
    kind: 'map',
    features: [],
    sources: [],
    connections: [],
    updatedAt: new Date().toISOString(),
  };
  useConversationStore.setState({
    conversations: [
      {
        id: 'map-1',
        name: 'Map',
        messages: [],
        model: {
          id: 'gpt-4',
          name: 'GPT-4',
          maxLength: 4000,
          tokenLimit: 4000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        conversationType: 'map',
        workflowState,
      } as unknown as Conversation,
    ],
    selectedConversationId: 'map-1',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function state(): MapWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as MapWorkflowState;
}

function renderWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MapWorkspace conversationId="map-1" />
    </QueryClientProvider>,
  );
}

describe('Map workflow — importing a structured file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
    useSettingsStore.setState({ mapImportDefaultConfidence: 'high' });
  });

  it('previews a pasted GeoJSON and lands it on confirm, with no model call', async () => {
    renderWorkspace();
    const box = await screen.findByPlaceholderText('map.inputPlaceholder');
    fireEvent.change(box, { target: { value: GEOJSON } });
    fireEvent.click(screen.getByRole('button', { name: 'map.mapIt' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await waitFor(() => expect(state().features).toHaveLength(2));
    expect(extractMapFeatures).not.toHaveBeenCalled();
    expect(state().features.map((f) => f.name)).toEqual(['Goma', 'Bukavu']);
    expect(state().features[0]).toMatchObject({
      lat: -1.6585,
      lon: 29.2205,
      confidence: 'high',
      category: 'city',
    });
    const source = state().sources[0];
    expect(source).toMatchObject({ kind: 'import', featureCount: 2 });
    expect(state().features.every((f) => f.sourceId === source.id)).toBe(true);
    // The paste box is cleared once its content is on the map. Re-queried:
    // landing the first features swaps the empty-state layout for the full
    // one, which remounts the composer, so the node captured above is stale.
    await waitFor(() =>
      expect(
        (
          screen.getByPlaceholderText(
            'map.inputPlaceholder',
          ) as HTMLTextAreaElement
        ).value,
      ).toBe(''),
    );
  });

  it('still sends prose to the model', async () => {
    extractMapFeatures.mockResolvedValue({
      features: [],
      connections: [],
      citations: [],
      truncatedSource: false,
    });
    renderWorkspace();
    const box = await screen.findByPlaceholderText('map.inputPlaceholder');
    fireEvent.change(box, {
      target: { value: 'Teams moved from Goma to Bukavu in March.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'map.mapIt' }));

    await waitFor(() => expect(extractMapFeatures).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the preview leaves the map untouched', async () => {
    renderWorkspace();
    const box = await screen.findByPlaceholderText('map.inputPlaceholder');
    fireEvent.change(box, { target: { value: GEOJSON } });
    fireEvent.click(screen.getByRole('button', { name: 'map.mapIt' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state().features).toHaveLength(0);
  });
});
