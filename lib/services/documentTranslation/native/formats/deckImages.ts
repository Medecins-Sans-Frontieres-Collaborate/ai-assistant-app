/**
 * The page images of a presentation run, drawn on the server from the
 * slides LibreOffice rendered (the PDF script draws its own; these match
 * them): units outlined in magenta and numbered.
 *
 *   labelled  one slide, each unit's text outlined where it was measured
 *             (bbox): what the analyze step reads units from
 *   check     the original beside the translated slide, each translated
 *             unit outlined where it may be laid out (room): what the
 *             layout check looks at
 *   preview   the translated slide alone: what the person reads
 *
 * Coordinates are points (the deck script's CONVENTIONS); a picture made
 * at `dpi` has `dpi / 72` pixels per point.
 */
import sharp from 'sharp';

/** Resolution the slides are rendered at: the preview's. */
export const SLIDE_RENDER_DPI = 144;
/** Resolution of the labelled and check images, as the PDF script's. */
export const CHECK_IMAGE_DPI = 100;

const OUTLINE = '#ff0099';
const GAP_PX = 8;
const GAP_COLOR = { r: 40, g: 40, b: 40, alpha: 1 };

/** A unit as drawn: its number and a box in points. */
export interface DrawnUnit {
  n: number;
  box: [number, number, number, number];
}

const escapeXml = (text: string): string =>
  text.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** An SVG of numbered outlines, sized to the picture. */
function outlines(
  units: DrawnUnit[],
  width: number,
  height: number,
  scale: number,
): Buffer {
  const shapes = units.map(({ n, box }) => {
    const [x0, y0, x1, y1] = box.map((value) => value * scale);
    const label = String(n);
    const tagWidth = (4 + 4 * label.length) * scale;
    const tagHeight = 8.5 * scale;
    let tagX = x0 - tagWidth - scale;
    let tagY = y0;
    if (tagX < 0) {
      tagX = x0;
      tagY = Math.max(0, y0 - tagHeight);
    }
    return [
      `<rect x="${x0}" y="${y0}" width="${Math.max(1, x1 - x0)}" height="${Math.max(1, y1 - y0)}" fill="none" stroke="${OUTLINE}" stroke-width="${0.6 * scale}"/>`,
      `<rect x="${tagX}" y="${tagY}" width="${tagWidth}" height="${tagHeight}" fill="${OUTLINE}"/>`,
      `<text x="${tagX + 2 * scale}" y="${tagY + tagHeight - 2 * scale}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${7 * scale}" fill="#ffffff">${escapeXml(label)}</text>`,
    ].join('');
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join('')}</svg>`,
  );
}

/** A slide picture at the check resolution, with units outlined when given. */
async function atCheckSize(
  png: Uint8Array,
  units: DrawnUnit[] = [],
): Promise<{ data: Buffer; width: number; height: number }> {
  const meta = await sharp(png).metadata();
  const width = Math.max(
    1,
    Math.round(((meta.width ?? 1) * CHECK_IMAGE_DPI) / SLIDE_RENDER_DPI),
  );
  const height = Math.max(
    1,
    Math.round(((meta.height ?? 1) * CHECK_IMAGE_DPI) / SLIDE_RENDER_DPI),
  );
  let image = sharp(png)
    .resize(width, height)
    .flatten({ background: '#ffffff' });
  if (units.length > 0) {
    image = sharp(await image.png().toBuffer()).composite([
      {
        input: outlines(units, width, height, CHECK_IMAGE_DPI / 72),
        top: 0,
        left: 0,
      },
    ]);
  }
  return { data: await image.png().toBuffer(), width, height };
}

/**
 * The labelled image of a slide for the analyze step.
 *
 * @param slide - PNG of the slide at SLIDE_RENDER_DPI.
 * @param units - The slide's drawn units, outlined at their bbox.
 */
export async function labelledSlide(
  slide: Uint8Array,
  units: DrawnUnit[],
): Promise<Uint8Array> {
  return (await atCheckSize(slide, units)).data;
}

/**
 * The original beside the translated slide, for the layout check.
 *
 * @param original - PNG of the source slide at SLIDE_RENDER_DPI.
 * @param translated - PNG of the translated slide at SLIDE_RENDER_DPI.
 * @param units - Translated units, outlined at their room.
 */
export async function checkImage(
  original: Uint8Array,
  translated: Uint8Array,
  units: DrawnUnit[],
): Promise<Uint8Array> {
  const [left, right] = await Promise.all([
    atCheckSize(original),
    atCheckSize(translated, units),
  ]);
  return sharp({
    create: {
      width: left.width + GAP_PX + right.width,
      height: Math.max(left.height, right.height),
      channels: 4,
      background: GAP_COLOR,
    },
  })
    .composite([
      { input: left.data, top: 0, left: 0 },
      { input: right.data, top: 0, left: left.width + GAP_PX },
    ])
    .png()
    .toBuffer();
}
