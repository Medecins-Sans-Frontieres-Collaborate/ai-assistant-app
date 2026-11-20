import {
  LOGO_HASH_MAX_DISTANCE,
  backgroundAround,
  hammingDistance,
  matchLogo,
  pictureSignature,
} from '@/lib/services/brand/logoMatch';

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Logo matching on the brand fixture's logo (a teal disc and an ink bar,
 * 400 x 200): a squashed, a recompressed and an identical copy match; an
 * unrelated picture and a mirrored one do not. Background sampling on a
 * page picture with the logo's box painted over.
 */

const LOGO = fs.readFileSync(
  path.join(process.cwd(), '__tests__/fixtures/brand/logo.png'),
);

async function signatureOf(bytes: Uint8Array) {
  const signature = await pictureSignature(bytes);
  if (!signature) throw new Error('fixture could not be decoded');
  return signature;
}

describe('matching', () => {
  let logos: Array<{
    key: string;
    signature: Awaited<ReturnType<typeof signatureOf>>;
  }>;
  beforeAll(async () => {
    logos = [{ key: 'main', signature: await signatureOf(LOGO) }];
  });

  it('reads the logo’s own proportions', () => {
    expect(logos[0].signature).toMatchObject({
      width: 400,
      height: 200,
      aspect: 2,
    });
  });

  it('matches identical bytes outright', async () => {
    expect(matchLogo(await signatureOf(LOGO), logos)).toEqual({
      key: 'main',
      distance: 0,
    });
  });

  it('matches a squashed and a recompressed copy within the distance', async () => {
    const squashed = await sharp(LOGO)
      .resize(400, 100, { fit: 'fill' })
      .png()
      .toBuffer();
    const jpeg = await sharp(LOGO)
      .flatten({ background: '#ffffff' })
      .resize(160)
      .jpeg({ quality: 60 })
      .toBuffer();
    for (const copy of [squashed, jpeg]) {
      const match = matchLogo(await signatureOf(copy), logos);
      expect(match?.key).toBe('main');
      expect(match!.distance).toBeLessThanOrEqual(LOGO_HASH_MAX_DISTANCE);
    }
  });

  it('does not match a mirrored logo or an unrelated picture', async () => {
    const mirrored = await sharp(LOGO).flop().png().toBuffer();
    const unrelated = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#ffffff' },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="300" height="300"><rect x="0" y="150" width="300" height="150" fill="#000"/><rect x="0" y="0" width="60" height="300" fill="#f00"/></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    for (const other of [mirrored, unrelated]) {
      const signature = await signatureOf(other);
      expect(
        hammingDistance(signature.hash, logos[0].signature.hash),
      ).toBeGreaterThan(LOGO_HASH_MAX_DISTANCE);
      expect(matchLogo(signature, logos)).toBeNull();
    }
  });

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hammingDistance('0000000000000003', '0000000000000001')).toBe(1);
  });

  it('gives no signature for bytes that are no picture', async () => {
    expect(await pictureSignature(Buffer.from('not an image'))).toBeNull();
  });
});

describe('backgroundAround', () => {
  /** A 600 x 400 pt page at 2 px a point, sand, with the box painted ink. */
  async function page(box: [number, number, number, number], ground: string) {
    const [x0, y0, x1, y1] = box.map((v) => v * 2);
    return sharp({
      create: { width: 1200, height: 800, channels: 3, background: ground },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="1200" height="800"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#1b2a41"/></svg>`,
          ),
        },
      ])
      .png()
      .toBuffer();
  }

  it('reads the ground around the box, never the logo itself', async () => {
    const box: [number, number, number, number] = [100, 100, 300, 200];
    expect(
      await backgroundAround(
        await page(box, '#f2e8d5'),
        { width: 600, height: 400 },
        box,
      ),
    ).toBe('#f2e8d5');
  });

  it('takes the commonest colour of the whole band, not one point', async () => {
    const box: [number, number, number, number] = [100, 100, 300, 200];
    // A teal line crosses the band's left side (the band runs from 90.5
    // to 98.5 pt, 181 to 197 px): a probe there would read teal. The rest
    // of the band is white.
    const picture = await sharp(await page(box, '#ffffff'))
      .composite([
        {
          input: Buffer.from(
            '<svg width="1200" height="800"><rect x="183" y="0" width="12" height="800" fill="#0f7c80"/></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    expect(
      await backgroundAround(picture, { width: 600, height: 400 }, box),
    ).toBe('#ffffff');
    // The line really crosses the band: one pixel there is teal.
    const probe = await sharp(picture)
      .extract({ left: 189, top: 300, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect([...probe.subarray(0, 3)]).toEqual([0x0f, 0x7c, 0x80]);
  });

  it('reads a box at the page’s edge from the part of the band on the page', async () => {
    const box: [number, number, number, number] = [0, 0, 200, 100];
    expect(
      await backgroundAround(
        await page(box, '#f2e8d5'),
        { width: 600, height: 400 },
        box,
      ),
    ).toBe('#f2e8d5');
  });
});
