import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { notifyLimitsChanged } from '@/client/hooks/settings/limitsUxEvents';
import {
  MODELS_QUERY_KEY,
  useModelsQuery,
} from '@/client/hooks/settings/useModelsQuery';

import { OpenAIModelID } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

const okModels = (models: unknown[], source?: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { models, ...(source ? { source } : {}) } }),
});

describe('useModelsQuery', () => {
  const settingsInitial = useSettingsStore.getState();

  beforeEach(() => {
    useSettingsStore.setState(settingsInitial, true);
    useSettingsStore.getState().setModels([
      {
        id: 'seed' as OpenAIModelID,
        name: 'Seed',
        maxLength: 1,
        tokenLimit: 1,
      },
    ]);
    useSettingsStore.getState().setModelListSource('static');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches /api/models and writes the list + source into the store', async () => {
    const discovered = [
      { id: 'gpt-5.2', name: 'x', maxLength: 1, tokenLimit: 1 },
      { id: 'other-model', name: 'Other', maxLength: 1, tokenLimit: 1 },
    ];
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(okModels(discovered, 'discovery-partial'));
    vi.stubGlobal('fetch', fetchSpy);
    const { Wrapper } = makeWrapper();

    renderHook(() => useModelsQuery(), { wrapper: Wrapper });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/models'));
    await waitFor(() =>
      expect(useSettingsStore.getState().models.map((m) => m.id)).toEqual([
        'gpt-5.2',
        'other-model',
      ]),
    );
    expect(useSettingsStore.getState().modelListSource).toBe(
      'discovery-partial',
    );
  });

  it('re-resolves the default when the persisted default is not selectable in the discovered list', async () => {
    useSettingsStore
      .getState()
      .setDefaultModelId('removed-model' as OpenAIModelID);
    // EU user: the US-only entry first in the list must be skipped.
    useSettingsStore.getState().setUserRegion('EU');
    const discovered = [
      {
        id: 'us-only-model',
        name: 'US Only',
        maxLength: 1,
        tokenLimit: 1,
        hostedIn: ['US'],
      },
      {
        id: 'eu-model',
        name: 'EU Model',
        maxLength: 1,
        tokenLimit: 1,
        hostedIn: ['EU'],
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okModels(discovered)));
    const { Wrapper } = makeWrapper();

    renderHook(() => useModelsQuery(), { wrapper: Wrapper });

    await waitFor(() =>
      expect(useSettingsStore.getState().defaultModelId).toBe('eu-model'),
    );
  });

  it('keeps the persisted default when it is still present', async () => {
    useSettingsStore.getState().setDefaultModelId('keep-me' as OpenAIModelID);
    const discovered = [
      { id: 'keep-me', name: 'Keep Me', maxLength: 1, tokenLimit: 1 },
      { id: 'gpt-5.2', name: 'x', maxLength: 1, tokenLimit: 1 },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okModels(discovered)));
    const { Wrapper } = makeWrapper();

    renderHook(() => useModelsQuery(), { wrapper: Wrapper });

    await waitFor(() =>
      expect(useSettingsStore.getState().models.map((m) => m.id)).toContain(
        'keep-me',
      ),
    );
    expect(useSettingsStore.getState().defaultModelId).toBe('keep-me');
  });

  it('keeps the static seed on a failed fetch, an error status, or an empty list', async () => {
    const { Wrapper } = makeWrapper();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const failed = renderHook(() => useModelsQuery(), { wrapper: Wrapper });
    // retry: 1 → the error state lands after React Query's 1 s retry delay
    await waitFor(() => expect(failed.result.current.isError).toBe(true), {
      timeout: 4000,
    });
    expect(useSettingsStore.getState().modelListSource).toBe('static');
    expect(useSettingsStore.getState().models.map((m) => m.id)).toEqual([
      'seed',
    ]);
    failed.unmount();

    const { Wrapper: Wrapper2 } = makeWrapper();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const status = renderHook(() => useModelsQuery(), { wrapper: Wrapper2 });
    await waitFor(() => expect(status.result.current.isError).toBe(true), {
      timeout: 4000,
    });
    expect(useSettingsStore.getState().modelListSource).toBe('static');
    status.unmount();

    const { Wrapper: Wrapper3 } = makeWrapper();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okModels([])));
    const empty = renderHook(() => useModelsQuery(), { wrapper: Wrapper3 });
    await waitFor(() => expect(empty.result.current.isSuccess).toBe(true));
    expect(useSettingsStore.getState().modelListSource).toBe('static');
    expect(useSettingsStore.getState().models.map((m) => m.id)).toEqual([
      'seed',
    ]);
  });

  it('invalidates ["models"] and ["limits-me"] on the limits:changed event', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        okModels([{ id: 'gpt-5.2', name: 'x', maxLength: 1, tokenLimit: 1 }]),
      );
    vi.stubGlobal('fetch', fetchSpy);
    const { client, Wrapper } = makeWrapper();
    // A limits-me entry another hook would own; it must be marked stale too.
    client.setQueryData(['limits-me', 'gpt-5.2'], { limits: [] });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useModelsQuery(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    act(() => {
      notifyLimitsChanged();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: MODELS_QUERY_KEY });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['limits-me'] });
    // The active models query refetches right away despite staleTime.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(client.getQueryState(['limits-me', 'gpt-5.2'])?.isInvalidated).toBe(
      true,
    );
  });

  it('removes the event listener on unmount', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        okModels([{ id: 'gpt-5.2', name: 'x', maxLength: 1, tokenLimit: 1 }]),
      );
    vi.stubGlobal('fetch', fetchSpy);
    const { client, Wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result, unmount } = renderHook(() => useModelsQuery(), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    unmount();

    act(() => {
      notifyLimitsChanged();
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
