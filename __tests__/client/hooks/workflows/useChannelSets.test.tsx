import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useChannelSets } from '@/client/hooks/workflows/useChannelSets';

import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import { DEFAULT_CHANNEL_SET_ID } from '@/lib/utils/shared/drafter/channels/channelSets';

import { ChannelSetSummary } from '@/types/drafter';

import { afterEach, describe, expect, it, vi } from 'vitest';

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

const linkedin = CHANNEL_PROFILES.find((profile) => profile.id === 'linkedin')!;

const norway: ChannelSetSummary = {
  id: 'msf-no',
  name: 'MSF Norway',
  language: 'Norwegian',
  description: 'Oslo comms',
  isDefault: false,
  grant: 'group',
  defaults: { channelIds: ['linkedin'], articleLink: false, guideIds: [] },
  defaultVoices: { linkedin: 'guide-1' },
  channels: [{ ...linkedin, guidance: 'Skriv kort.' }],
};

function okResponse(sets: ChannelSetSummary[], suggestedSetId: string | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { sets, suggestedSetId } }),
  };
}

describe('useChannelSets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to one virtual default set while loading and on failure', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useChannelSets(), {
      wrapper: makeWrapper(),
    });

    // Before the answer: the built-in default over the built-in platforms.
    expect(result.current.isAuthoritative).toBe(false);
    expect(result.current.isSettled).toBe(false);
    expect(result.current.noSets).toBe(false);
    expect(result.current.sets).toHaveLength(1);
    expect(result.current.sets[0].id).toBe(DEFAULT_CHANNEL_SET_ID);
    expect(result.current.sets[0].channels.map((c) => c.id)).toEqual(
      CHANNEL_PROFILES.map((p) => p.id),
    );

    // After a failure: the same answer, now settled but never authoritative.
    // The hook retries once (after react-query's 1 s back-off) before giving up.
    await waitFor(() => expect(result.current.isSettled).toBe(true), {
      timeout: 4000,
    });
    expect(result.current.isAuthoritative).toBe(false);
    expect(result.current.noSets).toBe(false);
    expect(result.current.sets[0].id).toBe(DEFAULT_CHANNEL_SET_ID);
    expect(result.current.suggestedSetId).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith('/api/channel-sets');
  });

  it('returns the authoritative list and the suggested set once served', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse([norway], 'msf-no')),
    );

    const { result } = renderHook(() => useChannelSets(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isAuthoritative).toBe(true));
    expect(result.current.isSettled).toBe(true);
    expect(result.current.noSets).toBe(false);
    expect(result.current.sets).toEqual([norway]);
    expect(result.current.suggestedSetId).toBe('msf-no');
  });

  /**
   * The server's own empty answer (the default set restricted to others) is
   * not a blip to fail open from: the virtual default would fix drafts to a
   * set the server then refuses on every write.
   */
  it('reports no sets, and serves none, when the server lists none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([], null)));

    const { result } = renderHook(() => useChannelSets(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isAuthoritative).toBe(true));
    expect(result.current.noSets).toBe(true);
    expect(result.current.sets).toEqual([]);
    expect(result.current.isSettled).toBe(true);
  });
});
