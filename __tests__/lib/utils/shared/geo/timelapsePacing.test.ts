import {
  CARD_DURATION_MAX_MS,
  CARD_DURATION_MIN_MS,
  DEFAULT_MAP_TIMELAPSE,
  MAX_CARDS_MAX,
  cardStaggerMs,
  clampTimelapseSettings,
  keyframeDwellMs,
  sampleSpotlight,
} from '@/lib/utils/shared/geo/timelapsePacing';

import { describe, expect, it } from 'vitest';

const dwell = (
  cardCount: number,
  arrivalCount: number,
  cardDurationMs = DEFAULT_MAP_TIMELAPSE.cardDurationMs,
  reducedMotion = false,
) =>
  keyframeDwellMs({ cardCount, arrivalCount, cardDurationMs, reducedMotion });

describe('keyframeDwellMs', () => {
  it('holds a date longer the more arrives there', () => {
    const three = dwell(3, 3);
    const twelve = dwell(3, 12);
    const thirty = dwell(3, 30);

    expect(twelve).toBeGreaterThan(three);
    expect(thirty).toBeGreaterThan(twelve);
  });

  it('caps the bonus so one crowded date cannot stall the sweep', () => {
    expect(dwell(3, 500)).toBe(dwell(3, 1000));
    expect(dwell(3, 500)).toBeLessThan(dwell(3, 3) + 3000);
  });

  it('passes over a date where nothing arrives', () => {
    expect(dwell(0, 0)).toBeLessThan(dwell(1, 1));
  });

  it('scales with the configured card duration', () => {
    expect(dwell(2, 2, 5000)).toBeGreaterThan(dwell(2, 2, 1500));
  });

  it('slows down for reduced motion', () => {
    expect(dwell(2, 2, 2600, true)).toBeGreaterThan(dwell(2, 2, 2600, false));
  });
});

describe('cardStaggerMs', () => {
  it('keeps cards overlapping at any duration', () => {
    for (const duration of [1200, 2600, 6000]) {
      expect(cardStaggerMs(duration)).toBeLessThan(duration);
      expect(cardStaggerMs(duration)).toBeGreaterThan(0);
    }
  });
});

describe('sampleSpotlight', () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, i) => `f${i}`);

  it('shows everything when there is little enough to read', () => {
    expect(sampleSpotlight(ids(3), 3)).toEqual(['f0', 'f1', 'f2']);
    expect(sampleSpotlight(ids(2), 3)).toEqual(['f0', 'f1']);
  });

  it('never picks list-adjacent features when it has the room', () => {
    // Cards shown at the same time overlap, so neighbours in the ordering
    // would spotlight the same cluster twice.
    for (const offset of [0, 0.4, 0.99]) {
      const picked = sampleSpotlight(ids(20), 3, () => offset);
      const positions = picked.map((id) => Number(id.slice(1)));
      expect(picked).toHaveLength(3);
      expect(positions[1] - positions[0]).toBeGreaterThan(1);
      expect(positions[2] - positions[1]).toBeGreaterThan(1);
    }
  });

  it('stays inside the prominence shortlist', () => {
    // Ordered by prominence upstream, so a mention 40 places down never
    // outranks the primaries at the front.
    const picked = sampleSpotlight(ids(40), 3, () => 0.99);
    for (const id of picked) {
      expect(Number(id.slice(1))).toBeLessThan(6);
    }
  });

  it('varies between replays', () => {
    const first = sampleSpotlight(ids(20), 3, () => 0);
    const second = sampleSpotlight(ids(20), 3, () => 0.99);
    expect(first).not.toEqual(second);
  });

  it('honours a max of one', () => {
    expect(sampleSpotlight(ids(20), 1, () => 0)).toEqual(['f0']);
  });

  it('never returns holes for awkward pool sizes', () => {
    for (let total = 1; total <= 20; total++) {
      for (let max = 1; max <= MAX_CARDS_MAX; max++) {
        for (const offset of [0, 0.5, 0.99]) {
          const picked = sampleSpotlight(ids(total), max, () => offset);
          expect(picked).toHaveLength(Math.min(total, max));
          expect(picked.every(Boolean)).toBe(true);
          expect(new Set(picked).size).toBe(picked.length);
        }
      }
    }
  });
});

describe('clampTimelapseSettings', () => {
  it('falls back to defaults for missing or junk values', () => {
    expect(clampTimelapseSettings(undefined)).toEqual(DEFAULT_MAP_TIMELAPSE);
    expect(
      clampTimelapseSettings({ cardDurationMs: NaN, maxCardsPerDate: NaN }),
    ).toEqual(DEFAULT_MAP_TIMELAPSE);
  });

  it('clamps out-of-range values rather than dropping them', () => {
    expect(
      clampTimelapseSettings({ cardDurationMs: 0, maxCardsPerDate: 99 }),
    ).toEqual({
      cardDurationMs: CARD_DURATION_MIN_MS,
      maxCardsPerDate: MAX_CARDS_MAX,
    });
    expect(clampTimelapseSettings({ cardDurationMs: 1e9 }).cardDurationMs).toBe(
      CARD_DURATION_MAX_MS,
    );
  });

  it('keeps the valid half of a partially-broken value', () => {
    expect(
      clampTimelapseSettings({ cardDurationMs: 3000, maxCardsPerDate: -4 }),
    ).toEqual({ cardDurationMs: 3000, maxCardsPerDate: 1 });
  });
});
