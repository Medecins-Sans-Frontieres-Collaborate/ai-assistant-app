/**
 * Colour as a brand check compares it: perceptual distance (CIEDE2000)
 * between sRGB colours written `#rrggbb`.
 *
 * THE COLOUR CONVENTION (stated once; brand checks cite it):
 *  - Colours are compared in CIELAB (D65), never as hex or RGB numbers:
 *    two colours an eye cannot tell apart may differ by several RGB steps.
 *  - The distance is CIEDE2000 (`deltaE2000`). About 1 is the smallest
 *    difference a trained eye sees; 2 to 3 is what printing and screens
 *    commonly drift by; above 5 reads as another colour.
 *  - A colour MATCHES a brand colour when its distance is at most the
 *    tolerance plus COLOR_MATCH_EPSILON, so a colour authored exactly at
 *    the tolerance is not refused for a rounding hair.
 */

/** Added to every tolerance (see THE COLOUR CONVENTION). */
export const COLOR_MATCH_EPSILON = 1e-6;

/** A brand colour's default tolerance, in CIEDE2000 units. */
export const DEFAULT_COLOR_TOLERANCE = 3;

/** A colour in CIELAB (D65). */
export interface Lab {
  l: number;
  a: number;
  b: number;
}

const HEX_PATTERN = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

/** Whether text is a colour this module reads (`#rgb` or `#rrggbb`). */
export function isHexColor(text: string): boolean {
  return HEX_PATTERN.test(text.trim());
}

/**
 * A colour written the one way brand data stores it.
 *
 * @param text - `#rgb`, `#rrggbb`, with or without `#`, any case.
 * @returns Lowercase `#rrggbb`.
 * @throws Error for anything else.
 * @example normalizeHex('0F7') // '#00ff77'
 */
export function normalizeHex(text: string): string {
  const match = HEX_PATTERN.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not a #rrggbb colour`);
  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : match[1];
  return `#${digits.toLowerCase()}`;
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** sRGB `#rrggbb` to CIELAB (D65 white). */
export function hexToLab(hex: string): Lab {
  const value = normalizeHex(hex);
  const r = linear(parseInt(value.slice(1, 3), 16));
  const g = linear(parseInt(value.slice(3, 5), 16));
  const b = linear(parseInt(value.slice(5, 7), 16));
  // sRGB to XYZ, scaled by the D65 white point.
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number) =>
    t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/**
 * The CIEDE2000 colour difference (Sharma, Wu and Dalal, 2005), with the
 * usual weights kL = kC = kH = 1.
 */
export function deltaE2000(first: Lab, second: Lab): number {
  const c1 = Math.hypot(first.a, first.b);
  const c2 = Math.hypot(second.a, second.b);
  const meanC = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const a1 = (1 + g) * first.a;
  const a2 = (1 + g) * second.a;
  const c1p = Math.hypot(a1, first.b);
  const c2p = Math.hypot(a2, second.b);
  const hue = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const angle = toDegrees(Math.atan2(b, a));
    return angle >= 0 ? angle : angle + 360;
  };
  const h1p = hue(a1, first.b);
  const h2p = hue(a2, second.b);

  const deltaL = second.l - first.l;
  const deltaC = c2p - c1p;
  let deltaH = 0;
  if (c1p * c2p !== 0) {
    deltaH = h2p - h1p;
    if (deltaH > 180) deltaH -= 360;
    else if (deltaH < -180) deltaH += 360;
  }
  const deltaBigH = 2 * Math.sqrt(c1p * c2p) * Math.sin(toRadians(deltaH / 2));

  const meanL = (first.l + second.l) / 2;
  const meanCp = (c1p + c2p) / 2;
  let meanH = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) {
      meanH = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    } else {
      meanH = (h1p + h2p) / 2;
    }
  }
  const t =
    1 -
    0.17 * Math.cos(toRadians(meanH - 30)) +
    0.24 * Math.cos(toRadians(2 * meanH)) +
    0.32 * Math.cos(toRadians(3 * meanH + 6)) -
    0.2 * Math.cos(toRadians(4 * meanH - 63));
  const deltaTheta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7));
  const sl =
    1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const rt = -Math.sin(toRadians(2 * deltaTheta)) * rc;
  return Math.sqrt(
    (deltaL / sl) ** 2 +
      (deltaC / sc) ** 2 +
      (deltaBigH / sh) ** 2 +
      rt * (deltaC / sc) * (deltaBigH / sh),
  );
}

/** The CIEDE2000 distance between two `#rrggbb` colours. */
export function colorDistance(first: string, second: string): number {
  return deltaE2000(hexToLab(first), hexToLab(second));
}

/**
 * The nearest of some colours to one colour, and whether it matches (THE
 * COLOUR CONVENTION).
 *
 * @param color - `#rrggbb`.
 * @param palette - Colours with their own tolerance.
 * @returns The nearest, its distance and whether it is within tolerance;
 *   null for an empty palette.
 */
export function nearestColor<T extends { hex: string; tolerance?: number }>(
  color: string,
  palette: readonly T[],
): { color: T; distance: number; matches: boolean } | null {
  const lab = hexToLab(color);
  let best: { color: T; distance: number } | null = null;
  for (const entry of palette) {
    const distance = deltaE2000(lab, hexToLab(entry.hex));
    if (!best || distance < best.distance) best = { color: entry, distance };
  }
  if (!best) return null;
  const tolerance = best.color.tolerance ?? DEFAULT_COLOR_TOLERANCE;
  return { ...best, matches: best.distance <= tolerance + COLOR_MATCH_EPSILON };
}
