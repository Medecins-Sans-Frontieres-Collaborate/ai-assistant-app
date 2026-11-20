import {
  DeckComposeReport,
  composeDeck,
} from '@/lib/services/documents/model/deckEngine';
import { DECK_ENGINE_SCRIPT } from '@/lib/services/documents/model/deckEngineScript';

import type {
  DeckLayouts,
  DeckPlan,
} from '@/lib/utils/shared/documents/deckPlan';
import type { DocumentModel } from '@/lib/utils/shared/documents/documentModel';

import { pythonHas, runLocalScript } from '../../../../helpers/sandboxScript';

import { strFromU8, unzipSync } from 'fflate';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

/**
 * The presentation engine's `layouts` and `compose`, run here as the
 * sandbox runs them, on the brand template fixture (PowerPoint's own
 * layouts, one sample slide with a picture, notes and a section).
 */

// composeDeck itself runs here on this machine, under the sandbox's
// rules (runLocalScript refuses the input names the sandbox refuses).
vi.mock(
  '@/lib/services/documents/sandbox/sandboxScriptRunner',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    runSandboxScript: vi.fn(
      async (
        command: string,
        inputs: Parameters<typeof runLocalScript>[2],
        _usage: unknown,
        script: Parameters<typeof runLocalScript>[0],
      ) => ({
        files: runLocalScript(script, command, inputs),
        logs: '',
        durationMs: 0,
      }),
    ),
  }),
);

const FIXTURES = path.join(process.cwd(), '__tests__/fixtures/brand');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const LOGO = fixture('logo.png');

function layoutsOf(template: string): DeckLayouts {
  const files = runLocalScript(DECK_ENGINE_SCRIPT, 'layouts', [
    { filename: 'source.pptx', data: fixture(template) },
    { filename: 'job.json', data: Buffer.from('{"source":"source.pptx"}') },
  ]);
  return JSON.parse(strFromU8(files.get('layouts.json')!));
}

function compose(
  plan: DeckPlan,
  template = 'template.potx',
  images: Record<string, Buffer> = {},
): {
  refused?: { code: string; message: string };
  deck?: Uint8Array;
  report?: DeckComposeReport;
} {
  const names: Record<string, string> = {};
  const inputs = Object.entries(images).map(([key, data], at) => {
    names[key] = `picture${at + 1}.png`;
    return { filename: names[key], data };
  });
  const files = runLocalScript(DECK_ENGINE_SCRIPT, 'compose', [
    { filename: 'source.pptx', data: fixture(template) },
    ...inputs,
    {
      filename: 'job.json',
      data: Buffer.from(
        JSON.stringify({
          source: 'source.pptx',
          plan,
          images: names,
          language: 'en-GB',
        }),
      ),
    },
  ]);
  const refused = files.get('refused.json');
  if (refused) return { refused: JSON.parse(strFromU8(refused)) };
  return {
    deck: files.get('deck.pptx'),
    report: JSON.parse(strFromU8(files.get('report.json')!)),
  };
}

function inspect(deck: Uint8Array): DocumentModel {
  const files = runLocalScript(DECK_ENGINE_SCRIPT, 'inspect', [
    { filename: 'source.pptx', data: Buffer.from(deck) },
    { filename: 'job.json', data: Buffer.from('{"source":"source.pptx"}') },
  ]);
  return JSON.parse(strFromU8(files.get('model.json')!));
}

const parts = (deck: Uint8Array) => unzipSync(deck);
const text = (deck: Uint8Array, name: string) => strFromU8(parts(deck)[name]);

const BASE: DeckPlan = {
  slides: [
    {
      layout: 'slideLayout1',
      fills: [
        {
          placeholder: 'ctrTitle',
          kind: 'text',
          text: 'Northwind annual review',
        },
        { placeholder: '1', kind: 'text', text: 'Care close to home' },
      ],
      notes: 'Welcome everyone.',
    },
    {
      layout: 'slideLayout2',
      fills: [
        { placeholder: 'title', kind: 'text', text: 'What we did' },
        {
          placeholder: '1',
          kind: 'bullets',
          bullets: [
            { text: 'Opened three clinics', level: 0 },
            { text: 'In rural districts', level: 1 },
          ],
        },
      ],
      notes: '',
    },
  ],
};

describe.skipIf(!pythonHas(['lxml']))(
  'the presentation engine’s layouts',
  () => {
    const report = layoutsOf('template.potx');
    const byName = new Map(
      report.layouts.map((layout) => [layout.name, layout]),
    );

    it('lists every layout of the masters, with only what a plan may fill', () => {
      expect(report.layouts).toHaveLength(11);
      expect(report.slideSize).toEqual({ width: 720, height: 540 });
      expect(report.slideCount).toBe(1);
      const content = byName.get('Title and Content')!;
      expect(content.id).toBe('slideLayout2');
      expect(content.placeholders.map((p) => [p.key, p.role])).toEqual([
        ['title', 'title'],
        ['1', 'content'],
      ]);
      // Date, footer and slide number are the template's, not the plan's.
      expect(byName.get('Blank')!.placeholders).toEqual([]);
      expect(
        byName.get('Picture with Caption')!.placeholders.map((p) => p.role),
      ).toEqual(['title', 'picture', 'body']);
    });

    it('measures room for text, and marks text set sideways', () => {
      const content = byName.get('Title and Content')!;
      const [title, body] = content.placeholders;
      expect(title.lines).toBeLessThan(body.lines);
      expect(body.charsPerLine).toBeGreaterThan(20);
      expect(body.size).toBe(32);
      expect(
        byName
          .get('Title and Vertical Text')!
          .placeholders.find((p) => p.key === '1')!.vertical,
      ).toBe(true);
      expect(content.placeholders.some((p) => p.vertical)).toBe(false);
    });
  },
);

describe.skipIf(!pythonHas(['lxml']))(
  'the presentation engine’s compose',
  () => {
    const built = compose(BASE);
    const deck = built.deck!;

    it('builds the planned slides from their layouts, as a presentation', () => {
      expect(built.refused).toBeUndefined();
      expect(built.report!.slides.map((s) => [s.layout, s.filled])).toEqual([
        ['slideLayout1', ['ctrTitle', '1']],
        ['slideLayout2', ['title', '1']],
      ]);
      const types = text(deck, '[Content_Types].xml');
      expect(types).toContain('presentationml.presentation.main+xml');
      expect(types).not.toContain('presentationml.template.main+xml');
      const model = inspect(deck);
      expect(model.pageCount).toBe(2);
      const units = model.units.filter(
        (unit) => unit.kind !== 'layout' && unit.kind !== 'master',
      );
      expect(units.map((unit) => unit.text)).toEqual(
        expect.arrayContaining([
          'Northwind annual review',
          'Opened three clinics',
          'In rural districts',
        ]),
      );
      // The template's theme sets the text: the brand's heading typeface.
      expect(
        units.find((unit) => unit.text === 'What we did')!.runs[0].font,
      ).toBe('Montserrat');
      expect(
        units.find((unit) => unit.text === 'Northwind annual review')!.runs[0]
          .lang,
      ).toBe('en-GB');
    });

    it('keeps none of the sample slide: its text, picture, notes or section', () => {
      const names = Object.keys(parts(deck));
      expect(
        names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)),
      ).toHaveLength(2);
      expect(names.some((n) => n.startsWith('ppt/media/'))).toBe(false);
      const all = names
        .filter((n) => n.endsWith('.xml'))
        .map((n) => text(deck, n))
        .join('\n');
      expect(all).not.toContain('Sample slide');
      expect(all).not.toContain('Notes on the sample slide');
      expect(text(deck, 'ppt/presentation.xml')).not.toContain('sectionLst');
      // Every override names a part that exists.
      for (const [, part] of text(deck, '[Content_Types].xml').matchAll(
        /PartName="\/([^"]+)"/g,
      )) {
        expect(names).toContain(part);
      }
      // Masters and every layout stay.
      expect(
        names.filter((n) => /slideLayouts\/slideLayout\d+\.xml$/.test(n)),
      ).toHaveLength(11);
    });

    it('keeps notes where planned, and only there', () => {
      expect(built.report!.slides.map((s) => s.notes)).toEqual([true, false]);
      const notes = Object.keys(parts(deck)).filter((n) =>
        /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n),
      );
      expect(notes).toHaveLength(1);
      expect(text(deck, notes[0])).toContain('Welcome everyone.');
    });

    it('fits text that is too long and leaves text that fits', () => {
      const long =
        'A long bullet that goes on to show how the fit shrinks text that does not fit at the size the layout sets';
      const { report } = compose({
        slides: [
          BASE.slides[1],
          {
            layout: 'slideLayout2',
            fills: [
              { placeholder: 'title', kind: 'text', text: 'Too much' },
              {
                placeholder: '1',
                kind: 'bullets',
                bullets: Array.from({ length: 5 }, () => ({
                  text: long,
                  level: 0,
                })),
              },
            ],
            notes: '',
          },
        ],
      });
      const scales = (page: number) =>
        report!.units.filter((u) => u.page === page).map((u) => u.scale);
      expect(Math.min(...scales(1))).toBe(1);
      const shrunk = report!.units.filter((u) => u.page === 2 && u.scale < 1);
      expect(shrunk.length).toBeGreaterThan(0);
      expect(shrunk.every((u) => u.fits)).toBe(true);
    });

    it('places a picture whole by default, and cropped to fill when asked', () => {
      const picturePlan = (fit?: 'cover'): DeckPlan => ({
        slides: [
          {
            layout: 'slideLayout9',
            fills: [
              { placeholder: 'title', kind: 'text', text: 'Our mark' },
              {
                placeholder: '1',
                kind: 'image',
                image: 'logo',
                alt: 'The Northwind logo',
                ...(fit ? { fit } : {}),
              },
            ],
            notes: '',
          },
        ],
      });
      const whole = compose(picturePlan(), 'template.potx', { logo: LOGO });
      const slide = text(whole.deck!, 'ppt/slides/slide1.xml');
      expect(slide).toContain('descr="The Northwind logo"');
      expect(slide).not.toContain('srcRect');
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(
        slide.slice(slide.indexOf('<p:pic>')),
      )!;
      // The logo is 400 x 200: drawn at its own proportions.
      expect(Number(ext[1]) / Number(ext[2])).toBeCloseTo(2, 2);
      expect(Object.keys(parts(whole.deck!))).toContain(
        'ppt/media/composed1.png',
      );

      const cropped = text(
        compose(picturePlan('cover'), 'template.potx', { logo: LOGO }).deck!,
        'ppt/slides/slide1.xml',
      );
      expect(cropped).toContain('srcRect');
      // Cropped to fill: the placeholder's own place, no size of its own.
      expect(cropped.slice(cropped.indexOf('<p:pic>'))).not.toContain(
        '<a:xfrm>',
      );
    });

    it('builds from the .pptx the same as from the .potx', () => {
      const fromPptx = compose(BASE, 'template.pptx');
      expect(fromPptx.report!.slides).toEqual(built.report!.slides);
    });

    it('keeps text XML cannot hold out, rather than failing', () => {
      const { refused, deck: cleaned } = compose({
        slides: [
          {
            layout: 'slideLayout6',
            fills: [
              { placeholder: 'title', kind: 'text', text: 'Bell\u0007 here' },
            ],
            notes: '',
          },
        ],
      });
      expect(refused).toBeUndefined();
      expect(text(cleaned!, 'ppt/slides/slide1.xml')).toContain('Bell here');
    });

    it('refuses a plan that does not match the template, saying why', () => {
      const refusedFor = (plan: DeckPlan, images = {}) =>
        compose(plan, 'template.potx', images).refused;
      expect(refusedFor({ slides: [] })?.code).toBe('BAD_PLAN');
      expect(
        refusedFor({
          slides: [{ layout: 'slideLayout99', fills: [], notes: '' }],
        })?.message,
      ).toContain('slideLayout99');
      expect(
        refusedFor({
          slides: [
            {
              layout: 'slideLayout6',
              fills: [{ placeholder: '1', kind: 'text', text: 'x' }],
              notes: '',
            },
          ],
        })?.code,
      ).toBe('BAD_PLAN');
      expect(
        refusedFor(
          {
            slides: [
              {
                layout: 'slideLayout6',
                fills: [
                  {
                    placeholder: 'title',
                    kind: 'image',
                    image: 'logo',
                    alt: '',
                  },
                ],
                notes: '',
              },
            ],
          },
          { logo: LOGO },
        )?.message,
      ).toContain('image in a title');
      expect(
        refusedFor({
          slides: [
            {
              layout: 'slideLayout9',
              fills: [
                { placeholder: '1', kind: 'image', image: 'missing', alt: '' },
              ],
              notes: '',
            },
          ],
        })?.message,
      ).toContain('missing');
    });
  },
);

describe.skipIf(!pythonHas(['lxml']))('composeDeck', () => {
  const picturePlan = (image: string): DeckPlan => ({
    slides: [
      {
        layout: 'slideLayout2',
        fills: [
          { placeholder: 'title', kind: 'text', text: 'Pictures' },
          { placeholder: '1', kind: 'image', image, alt: 'A picture' },
        ],
        notes: '',
      },
    ],
  });
  const pictureParts = (deck: Uint8Array) =>
    Object.keys(unzipSync(deck)).filter((name) =>
      name.startsWith('ppt/media/'),
    );

  it('sends each picture under a name the sandbox takes, by what it is', async () => {
    const jpeg = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#0f7c80' },
    })
      .jpeg()
      .toBuffer();
    for (const [picture, extension] of [
      [LOGO, 'png'],
      [jpeg, 'jpg'],
    ] as const) {
      const { deck } = await composeDeck(
        fixture('template.potx'),
        picturePlan('logo:main'),
        new Map([['logo:main', new Uint8Array(picture)]]),
      );
      expect(
        pictureParts(deck).some((name) => name.endsWith(`.${extension}`)),
      ).toBe(true);
    }
  });

  it('refuses a picture that is not a PNG, JPEG or GIF', async () => {
    await expect(
      composeDeck(
        fixture('template.potx'),
        picturePlan('picture:1'),
        new Map([['picture:1', new Uint8Array(Buffer.from('<svg/>'))]]),
      ),
    ).rejects.toMatchObject({ code: 'BAD_IMAGE' });
  });
});
