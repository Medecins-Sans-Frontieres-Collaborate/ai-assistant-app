import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import { useUserSkills } from '@/client/hooks/settings/useUserSkills';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('merged skill picker catalog', () => {
  afterEach(() => vi.unstubAllGlobals());
  function setup(autoEnabled: boolean) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            skills: [
              {
                id: 'report',
                name: 'Org report',
                description: 'd',
                activation: 'auto',
              },
            ],
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    useSettingsStore.setState({
      skillsAutoEnabled: autoEnabled,
      userSkills: [
        {
          id: 'report',
          name: 'Personal report',
          description: 'd',
          instructions: 'Never sent during catalog fetch',
          activation: 'auto',
          enabled: true,
        },
        {
          id: 'off',
          name: 'Off',
          description: 'd',
          instructions: 'i',
          activation: 'off',
          enabled: true,
        },
      ],
    });
    return {
      fetch,
      ...renderHook(() => useUserSkills(), {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      }),
    };
  }
  it('merges personal metadata without transmitting personal bodies in a catalog request', async () => {
    const { result, fetch } = setup(true);
    await waitFor(() => expect(result.current.data?.length).toBe(2));
    expect(result.current.data?.map((skill) => skill.id)).toEqual([
      'report',
      'user:report',
    ]);
    expect(fetch).toHaveBeenCalledWith('/api/skills');
    expect(result.current.data?.[1]).not.toHaveProperty('instructions');
    expect(result.current.data?.[1].personal).toBe(true);
  });
  it('does not expose personal skills while automatic selection is off (they are never sent)', async () => {
    const { result } = setup(false);
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.some((skill) => skill.personal)).toBe(false);
  });
});
