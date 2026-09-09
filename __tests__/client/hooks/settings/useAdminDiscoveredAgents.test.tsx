/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';

import { useAdminDiscoveredAgents } from '@/client/hooks/settings/useAdminDiscoveredAgents';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FOUNDRY = {
  id: 'f1',
  name: 'Foundry One',
  agentName: 'f1',
  source: '/custom/path',
};
const ORG = {
  id: 'orgr-1',
  name: 'Org One',
  agentName: 'orgr-1',
  source: 'org-agent',
  type: 'org',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useAdminDiscoveredAgents', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useSettingsStore.setState({
      customAgentSources: [
        { id: 's', name: 'S', resourcePath: '/custom/path' },
      ],
    } as never);
    fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/agents/foundry')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ agents: [FOUNDRY], unavailable: false }),
        } as Response);
      }
      if (url === '/api/agents') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agents: [ORG] }),
        } as Response);
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches both halves, passes sources only to the Foundry route, and merges Foundry-first', async () => {
    const { result } = renderHook(() => useAdminDiscoveredAgents(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith('/api/agents');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/agents/foundry?sources=${encodeURIComponent('/custom/path')}`,
    );
    expect(result.current.data?.agents.map((a) => a.id)).toEqual([
      'f1',
      'orgr-1',
    ]);
    expect(result.current.isError).toBe(false);
    expect(result.current.isFoundryUnavailable).toBe(false);
  });

  it('keeps the app rows and flags Foundry when only discovery fails', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/agents/foundry')
        ? Promise.resolve({ ok: false, status: 503 } as Response)
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ agents: [ORG] }),
          } as Response),
    );
    const { result } = renderHook(() => useAdminDiscoveredAgents(), {
      wrapper,
    });
    // `retry: 1` in the hook means the error settles after one ~1s retry.
    await waitFor(
      () => expect(result.current.isFoundryUnavailable).toBe(true),
      { timeout: 5000 },
    );
    expect(result.current.data?.agents.map((a) => a.id)).toEqual(['orgr-1']);
    expect(result.current.isError).toBe(false);
  });

  it('reports an error when the app half fails', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/agents'
        ? Promise.resolve({ ok: false, status: 503 } as Response)
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ agents: [FOUNDRY] }),
          } as Response),
    );
    const { result } = renderHook(() => useAdminDiscoveredAgents(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: 5000,
    });
  });

  it('fetches nothing when disabled', () => {
    const { result } = renderHook(
      () => useAdminDiscoveredAgents({ enabled: false }),
      { wrapper },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });
});
