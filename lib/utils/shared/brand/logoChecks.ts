/**
 * The rules a placed logo is held to (docs/DOCUMENT_PLATFORM.md, phase F),
 * once the server has matched a picture of the document to one of the
 * book's logos (lib/services/brand/logoMatch.ts) and measured what is
 * around it. Pure: the measuring happens elsewhere.
 *
 *  - Distortion: the box it is drawn in has other proportions than the
 *    logo file, by more than the logo's `aspectTolerance`. Compared as a
 *    symmetric ratio, so a logo squashed to half its height and one
 *    stretched to twice its width are the same distance off.
 *  - Size: drawn narrower than the logo's `minWidthPt`.
 *  - Background: what surrounds it is none of the colours the logo may be
 *    shown on (`allowedColors`, any when the list is empty).
 */
import { DocumentImage } from '@/lib/utils/shared/documents/documentModel';

import { BrandLogo } from './brandBook';
import { judgeColor } from './brandChecks';
import { DEFAULT_COLOR_TOLERANCE } from './brandColor';
import { BrandFinding } from './brandFindings';

/** A ratio a hair over the tolerance from rounding still meets it. */
export const LOGO_ASPECT_EPSILON = 1e-3;
/** Half a point narrower than the minimum still meets it. */
export const LOGO_WIDTH_EPSILON_PT = 0.5;

/**
 * How far one proportion is from another: 0 when equal, 1 when one is
 * twice the other, whichever way.
 */
export function aspectDeviation(placed: number, own: number): number {
  const ratio = placed / own;
  return Math.max(ratio, 1 / ratio) - 1;
}

/** A width:height proportion as a report shows it. */
function proportion(aspect: number): string {
  return `${Math.round(aspect * 100) / 100}:1`;
}

/**
 * The findings for one picture matched to one logo.
 *
 * @param input.image - The picture as placed (needs a page box).
 * @param input.logo - The logo it was matched to.
 * @param input.logoAspect - The logo file's own width / height.
 * @param input.background - The colour measured around it, or null when
 *   it could not be measured.
 */
export function checkLogoPlacement(input: {
  image: DocumentImage;
  logo: BrandLogo;
  logoAspect: number;
  background: string | null;
}): BrandFinding[] {
  const { image, logo, logoAspect, background } = input;
  if (!image.box || !(logoAspect > 0)) return [];
  const width = image.box[2] - image.box[0];
  const height = image.box[3] - image.box[1];
  if (width <= 0 || height <= 0) return [];
  const base = {
    page: image.page,
    unitId: null,
    imageId: image.id,
    box: image.box,
    source: 'check' as const,
  };
  const findings: BrandFinding[] = [];

  const placedAspect = width / height;
  if (
    aspectDeviation(placedAspect, logoAspect) >
    logo.aspectTolerance + LOGO_ASPECT_EPSILON
  ) {
    findings.push({
      ...base,
      id: `logo-distorted:${image.id}`,
      rule: 'logo-distorted',
      severity: 'error',
      found: proportion(placedAspect),
      expected: [proportion(logoAspect)],
      note: logo.name,
    });
  }
  if (
    logo.minWidthPt !== undefined &&
    width < logo.minWidthPt - LOGO_WIDTH_EPSILON_PT
  ) {
    findings.push({
      ...base,
      id: `logo-small:${image.id}`,
      rule: 'logo-small',
      severity: 'error',
      found: String(Math.round(width)),
      expected: [String(logo.minWidthPt)],
      note: logo.name,
    });
  }
  if (background && logo.allowedColors.length > 0) {
    const judged = judgeColor(
      background,
      logo.allowedColors.map((hex) => ({
        hex,
        tolerance: DEFAULT_COLOR_TOLERANCE,
      })),
    );
    if (!judged.matches) {
      findings.push({
        ...base,
        id: `logo-background:${image.id}`,
        rule: 'logo-background',
        severity: 'warning',
        found: background,
        expected: judged.nearest,
        note: logo.name,
      });
    }
  }
  return findings;
}
