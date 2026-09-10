import {
  boundingCentre,
  flattenPositions,
  haversineKm,
} from '@/lib/utils/shared/geo/geometry';

import { describe, expect, it } from 'vitest';

describe('geometry helpers', () => {
  it('flattens any nesting to positions', () => {
    expect(
      flattenPositions([
        [
          [1, 2],
          [3, 4],
        ],
        [[5, 6]],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(flattenPositions([1, 2])).toEqual([[1, 2]]);
    expect(flattenPositions('x')).toEqual([]);
  });

  it('measures distance', () => {
    // Goma → Bukavu ≈ 100 km.
    expect(haversineKm([29.2205, -1.6585], [28.8628, -2.5083])).toBeCloseTo(
      102,
      -1,
    );
  });

  it('finds the bounding centre and a radius that covers every position', () => {
    const centre = boundingCentre([
      [29, -2],
      [30, -2],
      [30, -1],
      [29, -1],
    ]);
    expect(centre).toMatchObject({ lon: 29.5, lat: -1.5 });
    for (const p of [
      [29, -2],
      [30, -1],
    ] as [number, number][]) {
      expect(haversineKm([centre!.lon, centre!.lat], p)).toBeLessThanOrEqual(
        centre!.radiusKm + 1e-9,
      );
    }
    expect(boundingCentre([])).toBeNull();
    expect(boundingCentre([[999, 999]])).toBeNull();
  });
});
