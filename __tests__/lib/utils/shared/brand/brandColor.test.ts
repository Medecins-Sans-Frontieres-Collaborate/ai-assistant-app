import {
  COLOR_MATCH_EPSILON,
  Lab,
  colorDistance,
  deltaE2000,
  hexToLab,
  nearestColor,
  normalizeHex,
} from '@/lib/utils/shared/brand/brandColor';

import { describe, expect, it } from 'vitest';

/**
 * THE COLOUR CONVENTION (brandColor.ts): perceptual distance, checked on
 * the published CIEDE2000 test pairs and on both sides of a tolerance.
 */

describe('normalizeHex', () => {
  it('writes every accepted form one way', () => {
    expect(normalizeHex('0F7')).toBe('#00ff77');
    expect(normalizeHex(' #1B2A41 ')).toBe('#1b2a41');
  });

  it('refuses anything else', () => {
    expect(() => normalizeHex('#12345')).toThrow('not a #rrggbb');
    expect(() => normalizeHex('teal')).toThrow();
  });
});

describe('hexToLab', () => {
  it('maps white, black and a known red', () => {
    expect(hexToLab('#ffffff').l).toBeCloseTo(100, 2);
    expect(hexToLab('#000000').l).toBeCloseTo(0, 2);
    const red = hexToLab('#ff0000');
    expect(red.l).toBeCloseTo(53.24, 1);
    expect(red.a).toBeCloseTo(80.09, 1);
    expect(red.b).toBeCloseTo(67.2, 1);
  });
});

describe('deltaE2000', () => {
  // Pairs from Sharma, Wu and Dalal (2005), table 1.
  const pairs: Array<[Lab, Lab, number]> = [
    [{ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 }, 2.0425],
    [{ l: 50, a: 3.1571, b: -77.2803 }, { l: 50, a: 0, b: -82.7485 }, 2.8615],
    [{ l: 50, a: 2.5, b: 0 }, { l: 50, a: 0, b: -2.5 }, 4.3065],
    [{ l: 50, a: 2.5, b: 0 }, { l: 73, a: 25, b: -18 }, 27.1492],
    [{ l: 50, a: -0.001, b: 2.49 }, { l: 50, a: 0.0011, b: -2.49 }, 4.7461],
    [
      { l: 60.2574, a: -34.0099, b: 36.2677 },
      { l: 60.4626, a: -34.1751, b: 39.4387 },
      1.2644,
    ],
    [
      { l: 2.0776, a: 0.0795, b: -1.135 },
      { l: 0.9033, a: -0.0636, b: -0.5514 },
      0.9082,
    ],
  ];

  it.each(pairs)('matches the published value', (first, second, expected) => {
    expect(deltaE2000(first, second)).toBeCloseTo(expected, 3);
    // It is symmetric.
    expect(deltaE2000(second, first)).toBeCloseTo(expected, 3);
  });

  it('is zero for the same colour', () => {
    expect(colorDistance('#0f7c80', '#0F7C80')).toBe(0);
  });
});

describe('nearestColor', () => {
  const palette = [
    { name: 'ink', hex: '#1b2a41', tolerance: 3 },
    { name: 'teal', hex: '#0f7c80', tolerance: 3 },
  ];

  it('finds the nearest brand colour', () => {
    expect(nearestColor('#0f7d81', palette)).toMatchObject({
      color: { name: 'teal' },
      matches: true,
    });
    expect(nearestColor('#ff00ff', palette)?.matches).toBe(false);
    expect(nearestColor('#ffffff', [])).toBeNull();
  });

  it('matches at exactly the tolerance and refuses just past it', () => {
    const near = '#13858a';
    const distance = colorDistance(near, '#0f7c80');
    const at = [{ hex: '#0f7c80', tolerance: distance }];
    expect(nearestColor(near, at)?.matches).toBe(true);
    const under = [{ hex: '#0f7c80', tolerance: distance - 1e-3 }];
    expect(nearestColor(near, under)?.matches).toBe(false);
    // The epsilon is far smaller than any difference an eye sees.
    expect(COLOR_MATCH_EPSILON).toBeLessThan(1e-3);
  });
});
