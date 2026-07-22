import { render, waitFor } from '@testing-library/react';

import { OpenAIModelID } from '@/types/openai';

import { AppInitializer } from '@/components/Providers/AppInitializer';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable session holder (overrides the global vitest.setup.dom.ts mock) so
// tests can control the user's region for the selectability gate.
const mockSession = vi.hoisted(() => ({
  data: null as { user: { region: 'US' | 'EU' } } | null,
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession.data, status: 'authenticated' }),
}));

describe('AppInitializer - model discovery wiring (W6 / W7)', () => {
  const settingsInitial = useSettingsStore.getState();
  const conversationInitial = useConversationStore.getState();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSession.data = null;
    useSettingsStore.setState(settingsInitial, true);
    useConversationStore.setState(conversationInitial, true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('W6: seeds the static list synchronously, then always refines from /api/models (discovery has no flag)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { models: [] } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppInitializer />);

    // Static seed happened immediately…
    expect(useSettingsStore.getState().models.length).toBeGreaterThan(0);
    // …and the discovery refine fires unconditionally.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/models'));
  });

  it('W7: re-resolves the default when the persisted default is missing from the discovered list', async () => {
    // Persist a default that the discovery list will NOT contain.
    useSettingsStore
      .getState()
      .setDefaultModelId('removed-model' as OpenAIModelID);
    const setDefaultSpy = vi.spyOn(
      useSettingsStore.getState(),
      'setDefaultModelId',
    );

    const discovered = [
      {
        id: 'gpt-5.2-chat',
        name: 'GPT-5.2 Chat',
        maxLength: 8192,
        tokenLimit: 4096,
      },
      { id: 'other-model', name: 'Other', maxLength: 8192, tokenLimit: 4096 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { models: discovered } }),
      }),
    );

    render(<AppInitializer />);

    await waitFor(() =>
      expect(useSettingsStore.getState().models.map((m) => m.id)).toContain(
        'other-model',
      ),
    );
    // Re-resolved to the env default (which is present in the discovered list).
    await waitFor(() =>
      expect(setDefaultSpy).toHaveBeenCalledWith('gpt-5.2-chat'),
    );
  });

  it('W7: keeps the persisted default when it is still present in the discovered list', async () => {
    useSettingsStore.getState().setDefaultModelId('keep-me' as OpenAIModelID);

    const discovered = [
      { id: 'keep-me', name: 'Keep Me', maxLength: 8192, tokenLimit: 4096 },
      {
        id: 'gpt-5.2-chat',
        name: 'GPT-5.2 Chat',
        maxLength: 8192,
        tokenLimit: 4096,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { models: discovered } }),
      }),
    );

    // Spy AFTER setting the persisted default so the step-2 path (which won't
    // fire here, default is set) and step-4 re-resolution are both observable.
    const setDefaultSpy = vi.spyOn(
      useSettingsStore.getState(),
      'setDefaultModelId',
    );

    render(<AppInitializer />);

    await waitFor(() =>
      expect(useSettingsStore.getState().models.map((m) => m.id)).toContain(
        'keep-me',
      ),
    );
    // Default still present → no re-resolution.
    expect(setDefaultSpy).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().defaultModelId).toBe('keep-me');
  });

  it('keeps modelListSource=static (the seed marker) when the refine fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<AppInitializer />);

    // Give the failed refine a chance to settle; the static seed stays.
    await new Promise((r) => setTimeout(r, 10));
    warnSpy.mockRestore();
    expect(useSettingsStore.getState().modelListSource).toBe('static');
    expect(useSettingsStore.getState().models.length).toBeGreaterThan(0);
  });

  it('records the /api/models source (e.g. discovery-partial)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            models: [{ id: 'gpt-5.2', name: 'x', maxLength: 1, tokenLimit: 1 }],
            source: 'discovery-partial',
          },
        }),
      }),
    );

    render(<AppInitializer />);

    await waitFor(() =>
      expect(useSettingsStore.getState().modelListSource).toBe(
        'discovery-partial',
      ),
    );
  });

  it('mirrors the memories LD flag fail-closed: undefined (no LD provider) → false', async () => {
    vi.stubGlobal('fetch', vi.fn());
    // Pre-set true to prove the mirror actively resets a stale value — this
    // file runs without an LDProvider, so useFlags() yields all-undefined
    // flags and the fail-closed `=== true` mirror must land on false.
    useSettingsStore.setState({ memoriesFlagEnabled: true });

    render(<AppInitializer />);

    await waitFor(() =>
      expect(useSettingsStore.getState().memoriesFlagEnabled).toBe(false),
    );
  });

  it('setMemoriesFlagEnabled flips the runtime mirror (the true case the effect drives when LD serves the flag)', () => {
    useSettingsStore.getState().setMemoriesFlagEnabled(true);

    expect(useSettingsStore.getState().memoriesFlagEnabled).toBe(true);
  });

  it('mirrors the session region into the settings store', async () => {
    mockSession.data = { user: { region: 'US' } };
    vi.stubGlobal('fetch', vi.fn());

    render(<AppInitializer />);

    await waitFor(() =>
      expect(useSettingsStore.getState().userRegion).toBe('US'),
    );
  });

  it('re-resolves the default onto a SELECTABLE model, skipping foreign-region-only entries', async () => {
    mockSession.data = { user: { region: 'EU' } };
    useSettingsStore
      .getState()
      .setDefaultModelId('removed-model' as OpenAIModelID);
    const setDefaultSpy = vi.spyOn(
      useSettingsStore.getState(),
      'setDefaultModelId',
    );

    // discovered[0] is US-only: an EU user must never be defaulted onto it
    // (residency). US users are unrestricted — cross-region routing.
    const discovered = [
      {
        id: 'us-only-model',
        name: 'US Only',
        maxLength: 1,
        tokenLimit: 1,
        hostedIn: ['US'],
      },
      {
        id: 'us-model',
        name: 'EU Model',
        maxLength: 1,
        tokenLimit: 1,
        hostedIn: ['EU'],
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { models: discovered, source: 'discovery' },
        }),
      }),
    );

    render(<AppInitializer />);

    await waitFor(() => expect(setDefaultSpy).toHaveBeenCalledWith('us-model'));
  });
});
