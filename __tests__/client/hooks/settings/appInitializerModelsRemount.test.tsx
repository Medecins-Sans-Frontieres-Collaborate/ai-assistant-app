import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AppInitializer } from '@/components/Providers/AppInitializer';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for docs/LIMITS_USER_FACING_UX.md's confirmed finding
 * "Remounting AppInitializer with a warm ['models'] cache leaves the store
 * on the static seed permanently": `useModelsQuery()` (mounted before the
 * run-once seed effect in AppInitializer) applies a warm query-cache hit
 * FIRST on a remount (React runs a component's passive effects in hook
 * declaration order), then the seed effect used to unconditionally
 * overwrite the store back to the static, unfiltered catalog. This lives
 * here (not in the pre-existing, unowned
 * __tests__/components/Providers/AppInitializer.test.tsx) per WP-B's file
 * ownership (docs/LIMITS_USER_FACING_UX.md §7.5).
 */
function makeWrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

describe('AppInitializer + useModelsQuery: remount against a warm QueryClient', () => {
  const settingsInitial = useSettingsStore.getState();
  const conversationInitial = useConversationStore.getState();

  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState(settingsInitial, true);
    useConversationStore.setState(conversationInitial, true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the discovered list (and non-static source) across a remount instead of reverting to the static seed', async () => {
    const discovered = [
      { id: 'gpt-5.2', name: 'GPT-5.2', maxLength: 1, tokenLimit: 1 },
    ];
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { models: discovered, source: 'discovery' },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    // One QueryClient shared across both mounts — exactly like the
    // module-level singleton AppProviders.tsx constructs, which is why the
    // cache survives a client-side navigation away from and back to the
    // (chat) route group.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const Wrapper = makeWrapper(client);

    const first = render(<AppInitializer />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(useSettingsStore.getState().modelListSource).toBe('discovery'),
    );
    expect(useSettingsStore.getState().models.map((m) => m.id)).toEqual([
      'gpt-5.2',
    ]);

    first.unmount();

    // Remount: the ['models'] query is still warm (staleTime 60s, well
    // within range), so useQuery returns the cached discovered data
    // synchronously on the very first render.
    render(<AppInitializer />, { wrapper: Wrapper });

    // Must NOT regress to the static, unfiltered catalog.
    expect(useSettingsStore.getState().modelListSource).not.toBe('static');
    expect(useSettingsStore.getState().models.map((m) => m.id)).toEqual([
      'gpt-5.2',
    ]);
  });

  it('still seeds the static list on a genuinely cold store (first-ever mount)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { models: [] } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(<AppInitializer />, { wrapper: makeWrapper(client) });

    expect(useSettingsStore.getState().models.length).toBeGreaterThan(0);
    expect(useSettingsStore.getState().modelListSource).toBe('static');
  });
});
