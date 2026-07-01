import { render, waitFor } from '@testing-library/react';

import { OpenAIModelID } from '@/types/openai';

import { AppInitializer } from '@/components/Providers/AppInitializer';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable holder for the discovery flag so each test can flip it before the
// component imports `env`.
const flag = vi.hoisted(() => ({ discoveryEnabled: false }));

vi.mock('@/config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/environment')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED() {
        return flag.discoveryEnabled;
      },
    },
  };
});

describe('AppInitializer - model discovery wiring (W6 / W7)', () => {
  const settingsInitial = useSettingsStore.getState();
  const conversationInitial = useConversationStore.getState();

  beforeEach(() => {
    vi.restoreAllMocks();
    flag.discoveryEnabled = false;
    useSettingsStore.setState(settingsInitial, true);
    useConversationStore.setState(conversationInitial, true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('W6: does NOT fetch /api/models when discovery is disabled', async () => {
    flag.discoveryEnabled = false;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppInitializer />);

    // Give any (incorrectly-scheduled) async work a chance to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
    // Static initialization still happened.
    expect(useSettingsStore.getState().models.length).toBeGreaterThan(0);
  });

  it('W6: fetches /api/models when discovery is enabled', async () => {
    flag.discoveryEnabled = true;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { models: [] } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppInitializer />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/models'));
  });

  it('W7: re-resolves the default when the persisted default is missing from the discovered list', async () => {
    flag.discoveryEnabled = true;
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
    flag.discoveryEnabled = true;
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
});
