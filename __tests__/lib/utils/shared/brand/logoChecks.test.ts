import { BrandLogo } from '@/lib/utils/shared/brand/brandBook';
import {
  LOGO_ASPECT_EPSILON,
  LOGO_WIDTH_EPSILON_PT,
  aspectDeviation,
  checkLogoPlacement,
} from '@/lib/utils/shared/brand/logoChecks';
import { DocumentImage } from '@/lib/utils/shared/documents/documentModel';

import { describe, expect, it } from 'vitest';

/** A placed logo's rules, each tested on both sides of its line. */

const logo: BrandLogo = {
  id: 'main',
  name: 'Main logo',
  file: 'admin:brand-aaaaaaaaaaaa/x.png',
  minWidthPt: 72,
  allowedColors: ['#ffffff', '#f2e8d5'],
  aspectTolerance: 0.02,
};

/** A 2:1 logo drawn `width` wide and `height` high. */
function placed(width: number, height: number): DocumentImage {
  return {
    id: 'img1',
    page: 2,
    box: [50, 100, 50 + width, 100 + height],
    name: null,
    sha256: 'x',
    file: 'x.png',
    contentType: 'image/png',
  };
}

const rules = (image: DocumentImage, background: string | null = null) =>
  checkLogoPlacement({ image, logo, logoAspect: 2, background }).map(
    (f) => f.rule,
  );

describe('aspectDeviation', () => {
  it('is symmetric: squashed by half and stretched to double are as far off', () => {
    expect(aspectDeviation(4, 2)).toBeCloseTo(1);
    expect(aspectDeviation(1, 2)).toBeCloseTo(1);
    expect(aspectDeviation(2, 2)).toBe(0);
  });
});

describe('checkLogoPlacement', () => {
  it('brackets distortion at the logo’s tolerance', () => {
    expect(rules(placed(200, 100))).toEqual([]);
    // 1.9 % off: inside a 2 % tolerance.
    expect(aspectDeviation(203.8 / 100, 2)).toBeLessThan(0.02);
    expect(rules(placed(203.8, 100))).toEqual([]);
    // 2.5 % off: outside.
    expect(aspectDeviation(205 / 100, 2)).toBeGreaterThan(
      0.02 + LOGO_ASPECT_EPSILON,
    );
    expect(rules(placed(205, 100))).toEqual(['logo-distorted']);
    // The fixtures' squashed logo: half its height.
    expect(rules(placed(200, 50))).toEqual(['logo-distorted']);
  });

  it('brackets the minimum width with its epsilon', () => {
    expect(rules(placed(72, 36))).toEqual([]);
    expect(rules(placed(72 - LOGO_WIDTH_EPSILON_PT / 2, 35.875))).toEqual([]);
    expect(rules(placed(60, 30))).toEqual(['logo-small']);
  });

  it('checks the background against the colours it may be shown on', () => {
    expect(rules(placed(200, 100), '#fefefe')).toEqual([]);
    expect(rules(placed(200, 100), '#f2e8d5')).toEqual([]);
    expect(rules(placed(200, 100), '#1b2a41')).toEqual(['logo-background']);
    // Not measured, or any background allowed: no finding.
    expect(rules(placed(200, 100), null)).toEqual([]);
    expect(
      checkLogoPlacement({
        image: placed(200, 100),
        logo: { ...logo, allowedColors: [] },
        logoAspect: 2,
        background: '#1b2a41',
      }),
    ).toEqual([]);
  });

  it('says what it found and what the logo expects, on the picture’s box', () => {
    const [finding] = checkLogoPlacement({
      image: placed(200, 50),
      logo,
      logoAspect: 2,
      background: null,
    });
    expect(finding).toMatchObject({
      rule: 'logo-distorted',
      page: 2,
      imageId: 'img1',
      box: [50, 100, 250, 150],
      found: '4:1',
      expected: ['2:1'],
      note: 'Main logo',
    });
  });

  it('finds nothing for a picture with no box or no size', () => {
    expect(rules({ ...placed(200, 100), box: null })).toEqual([]);
    expect(rules(placed(0, 100))).toEqual([]);
  });
});
