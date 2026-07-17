import { act } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let useSettingsStore: typeof import('@/client/stores/settingsStore').useSettingsStore;

describe('settingsStore estimated usage (back-calculated history)', () => {
  beforeEach(async () => {
    localStorage.clear();

    const settingsModule = await import('@/client/stores/settingsStore');
    useSettingsStore = settingsModule.useSettingsStore;

    act(() => {
      useSettingsStore.setState({
        tokenUsageStats: {},
        tokenUsageFirstTrackedAt: null,
        estimatedUsageStats: {},
        historicalUsageBackfilledAt: null,
      });
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('mergeEstimatedUsage', () => {
    it('folds buckets in and stamps the marker atomically', () => {
      act(() => {
        useSettingsStore.getState().mergeEstimatedUsage({
          'gpt-test|default|none': {
            promptTokens: 100,
            completionTokens: 50,
            requests: 2,
          },
        });
      });

      const state = useSettingsStore.getState();
      expect(state.estimatedUsageStats['gpt-test|default|none']).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        requests: 2,
      });
      expect(state.historicalUsageBackfilledAt).not.toBeNull();
    });

    it('sums into existing buckets on repeated keys', () => {
      act(() => {
        useSettingsStore.getState().mergeEstimatedUsage({
          'gpt-test|default|none': {
            promptTokens: 100,
            completionTokens: 50,
            requests: 1,
          },
        });
        useSettingsStore.getState().mergeEstimatedUsage({
          'gpt-test|default|none': {
            promptTokens: 10,
            completionTokens: 5,
            requests: 1,
          },
        });
      });

      expect(
        useSettingsStore.getState().estimatedUsageStats[
          'gpt-test|default|none'
        ],
      ).toEqual({ promptTokens: 110, completionTokens: 55, requests: 2 });
    });
  });

  describe('markHistoricalBackfillDone', () => {
    it('stamps the marker without touching stats', () => {
      act(() => {
        useSettingsStore.getState().markHistoricalBackfillDone();
      });
      const state = useSettingsStore.getState();
      expect(state.historicalUsageBackfilledAt).not.toBeNull();
      expect(state.estimatedUsageStats).toEqual({});
    });

    it('preserves an existing marker', () => {
      act(() => {
        useSettingsStore.setState({
          historicalUsageBackfilledAt: '2026-01-01T00:00:00.000Z',
        });
        useSettingsStore.getState().markHistoricalBackfillDone();
      });
      expect(useSettingsStore.getState().historicalUsageBackfilledAt).toBe(
        '2026-01-01T00:00:00.000Z',
      );
    });
  });

  describe('resetTokenUsageStats', () => {
    it('clears both records and stamps the marker so backfill cannot resurrect cleared history', () => {
      act(() => {
        useSettingsStore.setState({
          tokenUsageStats: {
            'gpt-test|default|none': {
              promptTokens: 1,
              completionTokens: 1,
              requests: 1,
            },
          },
          estimatedUsageStats: {
            'gpt-test|default|none': {
              promptTokens: 2,
              completionTokens: 2,
              requests: 2,
            },
          },
          historicalUsageBackfilledAt: null,
        });
        useSettingsStore.getState().resetTokenUsageStats();
      });

      const state = useSettingsStore.getState();
      expect(state.tokenUsageStats).toEqual({});
      expect(state.estimatedUsageStats).toEqual({});
      expect(state.tokenUsageFirstTrackedAt).toBeNull();
      expect(state.historicalUsageBackfilledAt).not.toBeNull();
    });
  });

  describe('migration (v30 → v33)', () => {
    it('backfills the new fields', () => {
      const migrate = useSettingsStore.persist.getOptions().migrate!;
      const result = migrate({}, 30) as Record<string, unknown>;
      expect(result.estimatedUsageStats).toEqual({});
      expect(result.historicalUsageBackfilledAt).toBeNull();
    });

    it('wipes stale estimated buckets and re-arms the backfill (math corrections)', () => {
      const migrate = useSettingsStore.persist.getOptions().migrate!;
      for (const fromVersion of [31, 32]) {
        const result = migrate(
          {
            estimatedUsageStats: {
              'gpt-test|default|none': {
                promptTokens: 1,
                completionTokens: 2,
                requests: 3,
              },
            },
            historicalUsageBackfilledAt: '2026-07-01T00:00:00.000Z',
          },
          fromVersion,
        ) as Record<string, unknown>;
        expect(result.estimatedUsageStats).toEqual({});
        expect(result.historicalUsageBackfilledAt).toBeNull();
      }
    });

    it('preserves existing values on a v33 store', () => {
      const migrate = useSettingsStore.persist.getOptions().migrate!;
      const stats = {
        'gpt-test|default|none': {
          promptTokens: 1,
          completionTokens: 2,
          requests: 3,
        },
      };
      const result = migrate(
        {
          estimatedUsageStats: stats,
          historicalUsageBackfilledAt: '2026-07-01T00:00:00.000Z',
        },
        33,
      ) as Record<string, unknown>;
      expect(result.estimatedUsageStats).toEqual(stats);
      expect(result.historicalUsageBackfilledAt).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });
  });
});
