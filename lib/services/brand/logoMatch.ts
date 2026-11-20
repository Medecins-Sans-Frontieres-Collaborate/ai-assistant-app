/**
 * Which pictures of a document are the brand's logos, and what is around
 * them (docs/DOCUMENT_PLATFORM.md, phase F). The rules a matched logo is
 * held to are in lib/utils/shared/brand/logoChecks.ts.
 *
 * MATCHING: identical bytes match outright. Otherwise each picture is
 * reduced to a difference hash (dHash): flattened on white, grey, shrunk
 * to 9x8 IGNORING its proportions, one bit per neighbouring pair. A
 * squashed or recompressed logo keeps nearly the same 64 bits, so it is
 * still matched and the distortion rule (not the matcher) reports the
 * squashing. Pictures within LOGO_HASH_MAX_DISTANCE bits match.
 *
 * BACKGROUND: sampled in a band just outside the logo's box, on all four
 * sides, never at one point (a single probe lands on whatever sits there
 * and misses everything else). The commonest colour of the band wins.
 */
import Hasher from '@/lib/utils/app/hash';
import { PageBox } from '@/lib/utils/shared/documents/documentModel';

import sharp from 'sharp';

/** Most differing bits (of 64) for two pictures to be the same logo. */
export const LOGO_HASH_MAX_DISTANCE = 10;

/** What a picture is compared by. */
export interface PictureSignature {
  sha256: string;
  width: number;
  height: number;
  /** Width / height. */
  aspect: number;
  /** The 64-bit difference hash, as 16 hex digits. */
  hash: string;
}

/**
 * A picture's signature.
 *
 * @param bytes - A PNG, JPEG, SVG, GIF or WebP.
 * @returns Its signature, or null when it cannot be decoded.
 */
export async function pictureSignature(
  bytes: Uint8Array,
): Promise<PictureSignature | null> {
  try {
    const image = sharp(bytes, { failOn: 'none' });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return null;
    const pixels = await image
      .clone()
      .flatten({ background: '#ffffff' })
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();
    // 64 bits, four to a hex digit, row by row.
    let hash = '';
    let nibble = 0;
    for (let bit = 0; bit < 64; bit += 1) {
      const row = Math.floor(bit / 8);
      const column = bit % 8;
      const left = pixels[row * 9 + column];
      const right = pixels[row * 9 + column + 1];
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      if (bit % 4 === 3) {
        hash += nibble.toString(16);
        nibble = 0;
      }
    }
    return {
      sha256: Hasher.sha256(Buffer.from(bytes)),
      width: meta.width,
      height: meta.height,
      aspect: meta.width / meta.height,
      hash,
    };
  } catch {
    return null;
  }
}

/** How many of two hashes' 64 bits differ. */
export function hammingDistance(first: string, second: string): number {
  let count = 0;
  for (let at = 0; at < 16; at += 1) {
    let differing =
      Number.parseInt(first[at] ?? '0', 16) ^
      Number.parseInt(second[at] ?? '0', 16);
    while (differing > 0) {
      count += differing & 1;
      differing >>= 1;
    }
  }
  return count;
}

/**
 * The logo a picture is, if any: identical bytes first, then the nearest
 * hash within LOGO_HASH_MAX_DISTANCE.
 *
 * @returns The logo's key and the distance, or null.
 */
export function matchLogo<K>(
  picture: PictureSignature,
  logos: ReadonlyArray<{ key: K; signature: PictureSignature }>,
): { key: K; distance: number } | null {
  const identical = logos.find(
    (logo) => logo.signature.sha256 === picture.sha256,
  );
  if (identical) return { key: identical.key, distance: 0 };
  let best: { key: K; distance: number } | null = null;
  for (const logo of logos) {
    const distance = hammingDistance(picture.hash, logo.signature.hash);
    if (
      distance <= LOGO_HASH_MAX_DISTANCE &&
      (!best || distance < best.distance)
    ) {
      best = { key: logo.key, distance };
    }
  }
  return best;
}

/** The band's width: a share of the box's shorter side, within bounds. */
const BAND_SHARE = 0.08;
const BAND_MIN_PT = 3;
const BAND_MAX_PT = 18;
/** The gap between box and band, past anti-aliased edges. */
const BAND_GAP_PT = 1.5;

/**
 * The commonest colour just outside a box on a page picture.
 *
 * @param picture - The page as a PNG.
 * @param page - The page's size in points.
 * @param box - The box in page points.
 * @returns `#rrggbb`, or null when nothing of the band is on the page.
 */
export async function backgroundAround(
  picture: Uint8Array,
  page: { width: number; height: number },
  box: PageBox,
): Promise<string | null> {
  const { data, info } = await sharp(picture)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scale = info.width / page.width;
  const shorter = Math.min(box[2] - box[0], box[3] - box[1]);
  const band = Math.min(
    BAND_MAX_PT,
    Math.max(BAND_MIN_PT, shorter * BAND_SHARE),
  );
  const outer: PageBox = [
    box[0] - BAND_GAP_PT - band,
    box[1] - BAND_GAP_PT - band,
    box[2] + BAND_GAP_PT + band,
    box[3] + BAND_GAP_PT + band,
  ];
  const inner: PageBox = [
    box[0] - BAND_GAP_PT,
    box[1] - BAND_GAP_PT,
    box[2] + BAND_GAP_PT,
    box[3] + BAND_GAP_PT,
  ];
  const toPixel = (points: number, limit: number) =>
    Math.min(limit, Math.max(0, Math.round(points * scale)));
  const x0 = toPixel(outer[0], info.width);
  const y0 = toPixel(outer[1], info.height);
  const x1 = toPixel(outer[2], info.width);
  const y1 = toPixel(outer[3], info.height);
  const ix0 = toPixel(inner[0], info.width);
  const iy0 = toPixel(inner[1], info.height);
  const ix1 = toPixel(inner[2], info.width);
  const iy1 = toPixel(inner[3], info.height);

  // Colours binned at 4 bits a channel; each bin keeps its sums for the mean.
  const bins = new Map<
    number,
    { count: number; r: number; g: number; b: number }
  >();
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) continue;
      const at = (y * info.width + x) * info.channels;
      const r = data[at];
      const g = data[at + 1];
      const b = data[at + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bin.count += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
    }
  }
  let commonest: { count: number; r: number; g: number; b: number } | null =
    null;
  for (const bin of bins.values()) {
    if (!commonest || bin.count > commonest.count) commonest = bin;
  }
  if (!commonest) return null;
  const channel = (sum: number) =>
    Math.round(sum / commonest.count)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(commonest.r)}${channel(commonest.g)}${channel(commonest.b)}`;
}
