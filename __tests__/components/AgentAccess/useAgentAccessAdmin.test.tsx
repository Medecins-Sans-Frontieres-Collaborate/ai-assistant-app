import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

import {
  AgentAccessEnabledContext,
  useAgentAccessAdmin,
} from '@/client/hooks/settings/useAgentAccessAdmin';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    data: { isGlobalAdmin: true, isLocalAdmin: false, editableAgentKeys: '*' },
  }),
}));

function wrapperWith(enabled: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AgentAccessEnabledContext.Provider value={enabled}>
          {children}
        </AgentAccessEnabledContext.Provider>
      </QueryClientProvider>
    );
  };
}

describe('useAgentAccessAdmin', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never fetches /api/agent-access/me while the feature flag is disabled', async () => {
    const { result } = renderHook(() => useAgentAccessAdmin(), {
      wrapper: wrapperWith(false),
    });

    // Flag-off invariant: no network at all, quiet non-admin defaults.
    expect(result.current.me).toBeNull();
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.isGlobalAdmin).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();

    // Give any (buggy) fire-and-forget fetch a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults to disabled (no fetch) when no provider supplies the context', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useAgentAccessAdmin(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    expect(result.current.isAdmin).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches and reports admin status when the feature is enabled', async () => {
    const { result } = renderHook(() => useAgentAccessAdmin(), {
      wrapper: wrapperWith(true),
    });

    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-access/me');
    expect(result.current.isGlobalAdmin).toBe(true);
    expect(typeof result.current.refetch).toBe('function');
  });
});
