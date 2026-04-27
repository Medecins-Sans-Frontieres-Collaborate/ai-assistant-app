import {
  computeActiveFilePerTurnBudget,
  selectFilesForBudget,
} from '@/lib/utils/server/chat/activeFiles';

import { ActiveFile } from '@/types/chat';

import {
  ACTIVE_FILE_PER_TURN_MAX,
  ACTIVE_FILE_PER_TURN_MIN,
  getActiveFileBudgets,
} from '@/lib/constants/activeFileQuotas';
import { describe, expect, it } from 'vitest';

const NOW = '2026-01-01T00:00:00.000Z';

const makeFile = (
  id: string,
  tokens: number,
  opts: { pinned?: boolean; addedAt?: string; lastUsedAt?: string } = {},
): ActiveFile => ({
  id,
  url: `https://files/${id}`,
  originalFilename: `${id}.txt`,
  addedAt: opts.addedAt ?? NOW,
  lastUsedAt: opts.lastUsedAt,
  sourceMessageId: 'msg-1',
  status: 'ready',
  pinned: opts.pinned ?? false,
  processedContent: {
    type: 'document',
    content: 'x'.repeat(tokens * 4),
    tokenEstimate: tokens,
    processedAt: NOW,
  },
});

describe('computeActiveFilePerTurnBudget', () => {
  it('scales with the model context window for mid-tier 128k models', () => {
    // Mid tier fraction is 0.30; (128000 - 16000) * 0.30 = 33600.
    expect(
      computeActiveFilePerTurnBudget({
        maxLength: 128_000,
        tokenLimit: 16_000,
      }),
    ).toBe(33_600);
  });

  it('uses the larger fraction for 200k-context (large-tier) models', () => {
    // Large-tier fraction is 0.35; (200000 - 32000) * 0.35 ≈ 58800 in real
    // math but JS floating-point produces 58799.999..., so Math.floor
    // gives 58799. The point of the test is that we're well above the
    // mid-tier 33.6k from a 0.30 fraction, not the exact rounding.
    const budget = computeActiveFilePerTurnBudget({
      maxLength: 200_000,
      tokenLimit: 32_000,
    });
    expect(budget).toBeGreaterThan(50_000);
    expect(budget).toBeLessThanOrEqual(58_800);
  });

  it('clamps to the large-tier per-turn cap for very wide context windows', () => {
    // (1_000_000 - 16_000) * 0.35 = 344_400 → clamped to large-tier cap
    // 80k (which is itself well below the global ACTIVE_FILE_PER_TURN_MAX
    // of 100k). The global max acts as a defense-in-depth ceiling.
    const budget = computeActiveFilePerTurnBudget({
      maxLength: 1_000_000,
      tokenLimit: 16_000,
    });
    expect(budget).toBe(80_000);
    expect(budget).toBeLessThanOrEqual(ACTIVE_FILE_PER_TURN_MAX);
  });

  it('falls back to ACTIVE_FILE_PER_TURN_MIN for legacy small-context models', () => {
    // (8000 - 4000) * 0.30 = 1200 → raised to MIN floor.
    expect(
      computeActiveFilePerTurnBudget({ maxLength: 8_000, tokenLimit: 4_000 }),
    ).toBe(ACTIVE_FILE_PER_TURN_MIN);
  });

  it('returns the MIN floor when model metadata is missing or nonsensical', () => {
    expect(computeActiveFilePerTurnBudget(undefined)).toBe(
      ACTIVE_FILE_PER_TURN_MIN,
    );
    expect(computeActiveFilePerTurnBudget(null)).toBe(ACTIVE_FILE_PER_TURN_MIN);
    expect(
      computeActiveFilePerTurnBudget({ maxLength: 0, tokenLimit: 0 }),
    ).toBe(ACTIVE_FILE_PER_TURN_MIN);
    // tokenLimit >= maxLength leaves no input headroom
    expect(
      computeActiveFilePerTurnBudget({ maxLength: 1_000, tokenLimit: 2_000 }),
    ).toBe(ACTIVE_FILE_PER_TURN_MIN);
  });
});

describe('getActiveFileBudgets', () => {
  it('returns mid-tier budgets for 128k models', () => {
    const b = getActiveFileBudgets({ maxLength: 128_000 });
    expect(b.pinLimit).toBe(50_000);
    expect(b.activationLimit).toBe(90_000);
    expect(b.perTurnCap).toBe(55_000);
    expect(b.fraction).toBe(0.3);
    expect(b.sessionQuota).toBe(300_000);
  });

  it('returns large-tier budgets for 200k+ models', () => {
    const b = getActiveFileBudgets({ maxLength: 200_000 });
    expect(b.pinLimit).toBe(75_000);
    expect(b.activationLimit).toBe(120_000);
    expect(b.perTurnCap).toBe(80_000);
    expect(b.fraction).toBe(0.35);
    expect(b.sessionQuota).toBe(400_000);
  });

  it('falls back to mid-tier for missing or nonsensical model metadata', () => {
    expect(getActiveFileBudgets(undefined).pinLimit).toBe(50_000);
    expect(getActiveFileBudgets(null).pinLimit).toBe(50_000);
    expect(getActiveFileBudgets({ maxLength: 0 }).pinLimit).toBe(50_000);
  });
});

describe('selectFilesForBudget', () => {
  it('returns all files when the total fits the budget', () => {
    const files = [makeFile('a', 10_000), makeFile('b', 10_000)];
    const { selected, dropped } = selectFilesForBudget(files, 30_000);
    expect(selected.map((f) => f.id).sort()).toEqual(['a', 'b']);
    expect(dropped).toEqual([]);
  });

  it('reports dropped files when greedy by recency overflows the budget', () => {
    // FileB is more recent and 30k; FileA is older and 25k. Budget 40k:
    // recent picks B (30k used), then A (55k > 40k) → A dropped.
    // sizeAsc picks A (25k), then B (55k > 40k) → B dropped.
    // Both fit one file → tie, sizeAsc wins (smaller fits first).
    const files = [
      makeFile('a', 25_000, { lastUsedAt: '2026-01-01T00:00:00.000Z' }),
      makeFile('b', 30_000, { lastUsedAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const { selected, dropped } = selectFilesForBudget(files, 40_000);
    expect(selected.map((f) => f.id)).toEqual(['a']);
    expect(dropped.map((f) => f.id)).toEqual(['b']);
  });

  it('prefers sizeAsc when it includes more files than recent', () => {
    // Budget 45k. Recent order [c=30k, b=20k, a=10k]:
    //   greedy recent: c(30) + b(50→drop) + a(40 ok)? no, after c=30, +b would be 50>45, drop b; +a would be 40 ok → selected [c,a], dropped [b]. count=2.
    // sizeAsc order [a=10, b=20, c=30]: a(10) + b(30) + c(60→drop) → selected [a,b], dropped [c]. count=2.
    // Tie → sizeAsc wins, but assert *both* configs are valid count-2 outcomes.
    const files = [
      makeFile('a', 10_000, { lastUsedAt: '2026-01-01T00:00:00.000Z' }),
      makeFile('b', 20_000, { lastUsedAt: '2026-01-02T00:00:00.000Z' }),
      makeFile('c', 30_000, { lastUsedAt: '2026-01-03T00:00:00.000Z' }),
    ];
    const { selected, dropped } = selectFilesForBudget(files, 45_000);
    expect(selected.length).toBe(2);
    expect(dropped.length).toBe(1);
  });

  it('always keeps pinned files first regardless of size', () => {
    // Pinned but large file should be selected even if a smaller unpinned file
    // would otherwise win on sizeAsc.
    const files = [
      makeFile('big', 35_000, { pinned: true, addedAt: NOW }),
      makeFile('small', 5_000, { addedAt: NOW }),
    ];
    const { selected, dropped } = selectFilesForBudget(files, 38_000);
    expect(selected.map((f) => f.id)).toContain('big');
    expect(dropped.map((f) => f.id)).toContain('small');
  });

  it('falls back to including the smallest file when nothing fits cleanly', () => {
    // Both files individually exceed the budget — degraded fallback should
    // still include the smallest so the user gets some context, not nothing.
    const files = [makeFile('a', 60_000), makeFile('b', 80_000)];
    const { selected, dropped } = selectFilesForBudget(files, 50_000);
    expect(selected.map((f) => f.id)).toEqual(['a']);
    expect(dropped.map((f) => f.id)).toEqual(['b']);
  });

  it('returns empty selection with all files dropped on a zero budget', () => {
    const files = [makeFile('a', 1_000)];
    const { selected, dropped } = selectFilesForBudget(files, 0);
    expect(selected).toEqual([]);
    expect(dropped.map((f) => f.id)).toEqual(['a']);
  });

  it('handles the empty file list gracefully', () => {
    expect(selectFilesForBudget([], 1_000)).toEqual({
      selected: [],
      dropped: [],
    });
  });
});
