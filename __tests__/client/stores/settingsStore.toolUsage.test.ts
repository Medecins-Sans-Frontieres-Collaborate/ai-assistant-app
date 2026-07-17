import { act } from '@testing-library/react';

import { SETTINGS_CONSTANTS } from '@/lib/constants/settings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const THRESHOLD = SETTINGS_CONSTANTS.TOOL_ORDER.CONSECUTIVE_USAGE_THRESHOLD;

let useSettingsStore: typeof import('@/client/stores/settingsStore').useSettingsStore;

describe('settingsStore chat-input tool personalization', () => {
  beforeEach(async () => {
    localStorage.clear();

    const settingsModule = await import('@/client/stores/settingsStore');
    useSettingsStore = settingsModule.useSettingsStore;

    act(() => {
      useSettingsStore.setState({
        toolUsageCounts: {},
        consecutiveToolUsage: { toolId: null, count: 0 },
        pinnedToolIds: [],
        hiddenToolIds: [],
        revealedToolIds: [],
      });
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('recordSuccessfulToolUsage (debounced ordering)', () => {
    it('tracks consecutive usage without crediting on the first call', () => {
      act(() => {
        useSettingsStore.getState().recordSuccessfulToolUsage('attach');
      });

      const state = useSettingsStore.getState();
      expect(state.consecutiveToolUsage).toEqual({
        toolId: 'attach',
        count: 1,
      });
      expect(state.toolUsageCounts['attach']).toBeUndefined();
    });

    it(`credits the durable count after ${THRESHOLD} consecutive uses`, () => {
      for (let i = 0; i < THRESHOLD; i++) {
        act(() => {
          useSettingsStore.getState().recordSuccessfulToolUsage('attach');
        });
      }

      const state = useSettingsStore.getState();
      expect(state.toolUsageCounts['attach']).toBe(1);
      expect(state.consecutiveToolUsage).toEqual({
        toolId: 'attach',
        count: 0,
      });
    });

    it('resets the consecutive counter when switching tools', () => {
      act(() => {
        useSettingsStore.getState().recordSuccessfulToolUsage('attach');
      });
      act(() => {
        useSettingsStore.getState().recordSuccessfulToolUsage('translate');
      });

      const state = useSettingsStore.getState();
      expect(state.consecutiveToolUsage).toEqual({
        toolId: 'translate',
        count: 1,
      });
      expect(state.toolUsageCounts['attach']).toBeUndefined();
    });
  });

  describe('toggleToolHidden', () => {
    it('hides a normally-visible tool via hiddenToolIds', () => {
      act(() => {
        useSettingsStore.getState().toggleToolHidden('attach', false);
      });
      expect(useSettingsStore.getState().hiddenToolIds).toContain('attach');
    });

    it('un-hides a user-hidden tool', () => {
      act(() => {
        useSettingsStore.getState().toggleToolHidden('attach', false);
      });
      act(() => {
        useSettingsStore.getState().toggleToolHidden('attach', false);
      });
      expect(useSettingsStore.getState().hiddenToolIds).not.toContain('attach');
    });

    it('reveals a default-hidden tool via revealedToolIds', () => {
      // camera is default-hidden → first toggle should reveal it
      act(() => {
        useSettingsStore.getState().toggleToolHidden('camera', true);
      });
      const state = useSettingsStore.getState();
      expect(state.revealedToolIds).toContain('camera');
      expect(state.hiddenToolIds).not.toContain('camera');
    });

    it('re-hides a revealed default-hidden tool by dropping the reveal', () => {
      act(() => {
        useSettingsStore.getState().toggleToolHidden('camera', true);
      });
      act(() => {
        useSettingsStore.getState().toggleToolHidden('camera', true);
      });
      const state = useSettingsStore.getState();
      expect(state.revealedToolIds).not.toContain('camera');
      expect(state.hiddenToolIds).not.toContain('camera');
    });

    it('hiding a pinned tool also unpins it', () => {
      act(() => {
        useSettingsStore.getState().togglePinnedTool('attach');
      });
      expect(useSettingsStore.getState().pinnedToolIds).toContain('attach');

      act(() => {
        useSettingsStore.getState().toggleToolHidden('attach', false);
      });
      const state = useSettingsStore.getState();
      expect(state.pinnedToolIds).not.toContain('attach');
      expect(state.hiddenToolIds).toContain('attach');
    });
  });

  describe('togglePinnedTool', () => {
    it('pinning a hidden tool clears the explicit hide', () => {
      act(() => {
        useSettingsStore.getState().toggleToolHidden('attach', false);
      });
      expect(useSettingsStore.getState().hiddenToolIds).toContain('attach');

      act(() => {
        useSettingsStore.getState().togglePinnedTool('attach');
      });
      const state = useSettingsStore.getState();
      expect(state.pinnedToolIds).toContain('attach');
      expect(state.hiddenToolIds).not.toContain('attach');
    });
  });
});
