import { act, renderHook, waitFor } from '@testing-library/react';

import { useCustomSourceModels } from '@/client/hooks/useCustomSourceModels';

import { ModelSource, useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PATH_A =
  '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-a';
const PATH_B =
  '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-b';

const source = (id: string, resourcePath: string): ModelSource => ({
  id,
  name: id,
  resourcePath,
  createdAt: '2026-01-01T00:00:00.000Z',
  autoAddNewModels: true,
  excludedModelNames: [],
  selectedModelNames: [],
});

const model = (deploymentName: string) => ({
  id: `byom-abc123-${deploymentName}`,
  name: deploymentName,
  deploymentName,
  provider: 'openai',
  isCustomSourceModel: true,
});

interface Deferred {
  sources: string;
  refresh: boolean;
  resolve: (body: unknown) => void;
}

/**
 * Replaces global.fetch with a stub that records each /api/models/sources
 * call as a manually-resolvable deferred, so tests control response ordering.
 */
function stubDeferredFetch() {
  const calls: Deferred[] = [];
  const fn = vi.fn((url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    return new Promise((resolvePromise) => {
      calls.push({
        sources: params.get('sources') ?? '',
        refresh: params.get('refresh') === '1',
        resolve: (body: unknown) =>
          resolvePromise({
            ok: true,
            json: () => Promise.resolve(body),
          } as Response),
      });
    });
  });
  global.fetch = fn as unknown as typeof fetch;
  return calls;
}

const okBody = (entries: Array<Record<string, unknown>>) => ({
  sources: entries,
});

describe('useCustomSourceModels', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ customModelSources: [] });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches models for each source and keys them by resource path', async () => {
    const calls = stubDeferredFetch();
    useSettingsStore.setState({ customModelSources: [source('a', PATH_A)] });

    const { result } = renderHook(() => useCustomSourceModels());

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].sources).toBe(PATH_A);
    await act(async () => {
      calls[0].resolve(okBody([{ path: PATH_A, models: [model('my-gpt')] }]));
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.modelsBySource[PATH_A]).toHaveLength(1);
    expect(result.current.errorsBySource).toEqual({});
    expect(result.current.error).toBeNull();
  });

  it('ignores a stale response after disconnect + undo (latest pathsKey wins)', async () => {
    const calls = stubDeferredFetch();
    useSettingsStore.setState({
      customModelSources: [source('a', PATH_A), source('b', PATH_B)],
    });

    const { result } = renderHook(() => useCustomSourceModels());
    await waitFor(() => expect(calls).toHaveLength(1));

    // Disconnect A: a narrower fetch (B only) fires and stays in flight.
    act(() => {
      useSettingsStore.setState({ customModelSources: [source('b', PATH_B)] });
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].sources).toBe(PATH_B);

    // Undo restores A while the B-only request is still pending.
    act(() => {
      useSettingsStore.setState({
        customModelSources: [source('b', PATH_B), source('a', PATH_A)],
      });
    });
    await waitFor(() => expect(calls).toHaveLength(3));

    // The newest (both-sources) response lands first…
    await act(async () => {
      calls[2].resolve(
        okBody([
          { path: PATH_B, models: [model('b-gpt')] },
          { path: PATH_A, models: [model('a-gpt')] },
        ]),
      );
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // …then the stale B-only response resolves and must be dropped.
    await act(async () => {
      calls[1].resolve(okBody([{ path: PATH_B, models: [model('b-gpt')] }]));
      calls[0].resolve(okBody([]));
    });

    expect(result.current.modelsBySource[PATH_A]).toHaveLength(1);
    expect(result.current.modelsBySource[PATH_B]).toHaveLength(1);
    expect(result.current.errorsBySource[PATH_A]).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it('keeps per-source errors and marks paths the server dropped as unreachable', async () => {
    const calls = stubDeferredFetch();
    useSettingsStore.setState({
      customModelSources: [source('a', PATH_A), source('b', PATH_B)],
    });

    const { result } = renderHook(() => useCustomSourceModels());
    await waitFor(() => expect(calls).toHaveLength(1));

    // A fails discovery; B is missing from the response entirely (dropped
    // invalid path / prod OBO failure shape).
    await act(async () => {
      calls[0].resolve(
        okBody([{ path: PATH_A, models: [], error: 'discovery_failed' }]),
      );
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errorsBySource[PATH_A]).toBe('discovery_failed');
    expect(result.current.errorsBySource[PATH_B]).toBe('unreachable');
    expect(result.current.modelsBySource[PATH_B]).toEqual([]);
  });

  it('refresh() refetches with the cache-bust flag', async () => {
    const calls = stubDeferredFetch();
    useSettingsStore.setState({ customModelSources: [source('a', PATH_A)] });

    const { result } = renderHook(() => useCustomSourceModels());
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {
      calls[0].resolve(okBody([{ path: PATH_A, models: [] }]));
    });

    let refreshPromise: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].refresh).toBe(true);
    await act(async () => {
      calls[1].resolve(okBody([{ path: PATH_A, models: [model('my-gpt')] }]));
      await refreshPromise;
    });

    expect(result.current.modelsBySource[PATH_A]).toHaveLength(1);
  });
});
