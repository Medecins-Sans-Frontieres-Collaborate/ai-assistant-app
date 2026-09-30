import { act, renderHook } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ONE client poll (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §3). `CLIENT_BUILD`
 * is read at import time, so each case imports the module fresh.
 */
describe('useAppMessages', () => {
  const ORIGINAL_BUILD = process.env.NEXT_PUBLIC_BUILD;
  let fetchMock: ReturnType<typeof vi.fn>;

  const respond = (body: unknown) =>
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    });

  async function mount(build: string | undefined) {
    if (build === undefined) delete process.env.NEXT_PUBLIC_BUILD;
    else process.env.NEXT_PUBLIC_BUILD = build;
    vi.resetModules();
    const { useAppMessages } =
      await import('@/client/hooks/app/useAppMessages');
    const hook = renderHook(() => useAppMessages());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    return hook;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (ORIGINAL_BUILD !== undefined) {
      process.env.NEXT_PUBLIC_BUILD = ORIGINAL_BUILD;
    } else {
      delete process.env.NEXT_PUBLIC_BUILD;
    }
  });

  it('sends its build and locale, and reports an update the SERVER queued', async () => {
    respond({ build: '43', messages: [{ kind: 'update' }] });
    const { result } = await mount('42');

    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe('/api/version');
    expect(url.searchParams.get('build')).toBe('42');
    expect(url.searchParams.get('locale')).toBe('en');
    expect(result.current.isUpdateAvailable).toBe(true);
  });

  it('still detects a newer build from a replica that predates the funnel ({ build } alone)', async () => {
    respond({ build: '43' });
    const { result } = await mount('42');
    expect(result.current.isUpdateAvailable).toBe(true);
    expect(result.current.announcements).toEqual([]);
  });

  it('reports no update when the builds match', async () => {
    respond({ build: '42', messages: [] });
    const { result } = await mount('42');
    expect(result.current.isUpdateAvailable).toBe(false);
  });

  it('polls in local dev too — without a build, so an update is never reported — or announcements could not be tested locally', async () => {
    respond({
      build: 'unknown',
      messages: [{ kind: 'announcement', id: 'ann-000000000001' }],
    });
    const { result } = await mount(undefined);

    expect(fetchMock).toHaveBeenCalled();
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.has('build')).toBe(false);
    expect(result.current.isUpdateAvailable).toBe(false);
    expect(result.current.announcements).toHaveLength(1);
  });

  it('snoozes the refresh reminder for an hour', async () => {
    respond({ build: '43', messages: [{ kind: 'update' }] });
    const { result } = await mount('42');

    act(() => result.current.dismissUpdate());
    expect(result.current.isUpdateAvailable).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1_000);
    });
    expect(result.current.isUpdateAvailable).toBe(true);
  });

  it('keeps the last known state through a failed poll', async () => {
    respond({ build: '42', messages: [{ kind: 'announcement', id: 'a' }] });
    const { result } = await mount('42');
    expect(result.current.announcements).toHaveLength(1);

    fetchMock.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
    });
    expect(result.current.announcements).toHaveLength(1);
  });
});
