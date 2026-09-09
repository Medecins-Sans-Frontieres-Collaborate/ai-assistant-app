/**
 * @vitest-environment jsdom
 */
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';

import { useFoundryAgents } from '@/client/hooks/settings/useFoundryAgents';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_AGENT = {
  id: 'orgr-1',
  name: 'Org One',
  agentName: 'orgr-1',
  source: 'org-agent',
};
const FOUNDRY_RESPONSE = { agents: [], regionalPath: null, officePaths: [] };

function ok(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

/**
 * A fresh cache per case: the hook's recovery behaviour is a property of the
 * query options, and a shared client would carry a previous case's error
 * state (and its retry timers) into the next one. The defaults mirror
 * components/Providers/AppProviders.tsx — `refetchOnWindowFocus: false` there
 * is exactly what the hook has to override, so a client using React Query's
 * own `true` default would pass these tests with the override deleted.
 */
function renderAgents() {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useFoundryAgents(), { wrapper }), client };
}

/** The predicate React Query calls with the live Query; only `state` matters. */
type FocusPredicate = (query: { state: { status: string } }) => boolean;

describe('useFoundryAgents', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useSettingsStore.setState({ customAgentSources: [] } as never);
    fetchMock = vi.fn((url: string) =>
      url.startsWith('/api/agents/foundry')
        ? ok(FOUNDRY_RESPONSE)
        : ok({ agents: [APP_AGENT] }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Leave the singleton as we found it, or a later suite inherits "focused".
    focusManager.setFocused(undefined);
    vi.restoreAllMocks();
  });

  it('refetches the app half on window focus while it is errored, and leaves a healthy list alone', async () => {
    let appCalls = 0;
    let appFails = true;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/agents/foundry')) return ok(FOUNDRY_RESPONSE);
      appCalls += 1;
      return appFails
        ? Promise.resolve({ ok: false, status: 503 } as Response)
        : ok({ agents: [APP_AGENT] });
    });

    const { result } = renderAgents();
    await waitFor(
      () => expect(result.current.isFoundryAgentsError).toBe(true),
      { timeout: 15000 },
    );
    const callsWhileErrored = appCalls;

    // The regression: /api/agents was fetched once per page load and this
    // hook never unmounts, so a transient 503 hid every admin-managed agent
    // for the rest of the session.
    appFails = false;
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(
      () =>
        expect(result.current.foundryAgents.map((a) => a.id)).toEqual([
          'orgr-1',
        ]),
      { timeout: 15000 },
    );
    expect(appCalls).toBeGreaterThan(callsWhileErrored);

    // …and only while errored: a focus on a good list must stay free.
    const callsAfterRecovery = appCalls;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(appCalls).toBe(callsAfterRecovery);
  }, 20000);

  it('gives both halves the errored-only focus predicate', async () => {
    const { result, client } = renderAgents();
    await waitFor(() =>
      expect(result.current.isLoadingFoundryAgents).toBe(false),
    );

    for (const queryKey of [['app-agents'], ['foundry-agents']]) {
      const query = client.getQueryCache().find({ queryKey });
      // `refetchOnWindowFocus` is an observer option, so it is not on the
      // Query's own option type even though the observer writes it there.
      const predicate = (
        query?.options as { refetchOnWindowFocus?: FocusPredicate } | undefined
      )?.refetchOnWindowFocus;
      expect(typeof predicate).toBe('function');
      expect(predicate!({ state: { status: 'error' } })).toBe(true);
      expect(predicate!({ state: { status: 'success' } })).toBe(false);
      expect(predicate!({ state: { status: 'pending' } })).toBe(false);
    }
  });

  it('fails a hung request on the timeout instead of spinning forever', async () => {
    // Stand in for the real timer: the composed signal still aborts with a
    // TimeoutError reason, which is the branch under test.
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/agents/foundry')) return ok(FOUNDRY_RESPONSE);
      const signal = init?.signal;
      // Retries after the timeout has fired abort before they start.
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    });

    const { result } = renderAgents();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => call[0] === '/api/agents'),
      ).toBe(true),
    );
    expect(result.current.isFoundryAgentsError).toBe(false);

    timeoutController.abort(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );

    await waitFor(
      () => expect(result.current.isFoundryAgentsError).toBe(true),
      { timeout: 15000 },
    );
    const error = result.current.foundryAgentsError as Error;
    // A plain Error, not an abort: React Query retries it and the picker
    // can show it. An AbortError here would read as "user cancelled".
    expect(error.name).toBe('Error');
    expect(error.message).toContain(
      'Timed out after 15000ms fetching /api/agents',
    );
  }, 20000);

  it('passes a non-timeout abort through untouched', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/agents/foundry')
        ? ok(FOUNDRY_RESPONSE)
        : Promise.reject(
            new DOMException('The operation was aborted.', 'AbortError'),
          ),
    );

    const { result } = renderAgents();
    await waitFor(
      () => expect(result.current.isFoundryAgentsError).toBe(true),
      { timeout: 15000 },
    );
    const error = result.current.foundryAgentsError as Error;
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('The operation was aborted.');
  }, 20000);
});
