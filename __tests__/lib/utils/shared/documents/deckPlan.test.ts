import {
  DeckLayouts,
  DeckPlaceholder,
  DeckPlan,
  FIT_MIN_SCALE,
  MAX_PLAN_SLIDES,
  checkDeckPlan,
  linesNeeded,
  plannableLayouts,
  textFit,
} from '@/lib/utils/shared/documents/deckPlan';

import { describe, expect, it } from 'vitest';

const place = (
  key: string,
  role: DeckPlaceholder['role'],
  changes: Partial<DeckPlaceholder> = {},
): DeckPlaceholder => ({
  key,
  role,
  accepts:
    role === 'title' || role === 'subtitle'
      ? ['text']
      : role === 'picture'
        ? ['image']
        : role === 'body'
          ? ['text', 'bullets']
          : ['text', 'bullets', 'image'],
  name: `${role} ${key}`,
  box: [0, 0, 100, 100],
  size: 20,
  lines: 4,
  charsPerLine: 10,
  vertical: false,
  ...changes,
});

const LAYOUTS: DeckLayouts = {
  slideSize: { width: 720, height: 540 },
  slideCount: 1,
  layouts: [
    {
      id: 'slideLayout2',
      name: 'Title and Content',
      type: 'obj',
      master: 'slideMaster1',
      placeholders: [
        place('title', 'title', { lines: 1, charsPerLine: 30 }),
        place('1', 'content'),
      ],
    },
    {
      id: 'slideLayout7',
      name: 'Blank',
      type: 'blank',
      master: 'slideMaster1',
      placeholders: [],
    },
    {
      id: 'slideLayout10',
      name: 'Title and Vertical Text',
      type: 'vertTx',
      master: 'slideMaster1',
      placeholders: [
        place('title', 'title'),
        place('1', 'body', { vertical: true }),
      ],
    },
  ],
};

const slide = (
  fills: DeckPlan['slides'][number]['fills'],
  layout = 'slideLayout2',
) => ({
  layout,
  fills,
  notes: '',
});

describe('the plan capacity', () => {
  const box = { lines: 4, charsPerLine: 10 };
  const lines = (count: number) =>
    Array.from({ length: count }, () => ({
      text: 'x'.repeat(10),
      level: null,
    }));

  it('counts a paragraph’s lines, and a bullet’s shorter ones', () => {
    expect(linesNeeded([{ text: 'x'.repeat(10), level: null }], box, 1)).toBe(
      1,
    );
    expect(linesNeeded([{ text: 'x'.repeat(11), level: null }], box, 1)).toBe(
      2,
    );
    // A bullet loses its indent: ten characters no longer fit one line.
    expect(linesNeeded([{ text: 'x'.repeat(10), level: 0 }], box, 1)).toBe(2);
    expect(linesNeeded([{ text: '', level: null }], box, 1)).toBe(1);
  });

  it('fits at the edge, shrinks just past it, and refuses past the fit', () => {
    expect(textFit(lines(4), box)).toBe('fits');
    expect(textFit(lines(5), box)).toBe('shrinks');
    // At the smallest scale the box holds 4 / 0.7 = 5.7 lines of 14 characters.
    expect(Math.floor(box.lines / FIT_MIN_SCALE)).toBe(5);
    expect(textFit([{ text: 'x'.repeat(14 * 5), level: null }], box)).toBe(
      'shrinks',
    );
    expect(textFit([{ text: 'x'.repeat(14 * 6), level: null }], box)).toBe(
      'too-long',
    );
  });
});

describe('checkDeckPlan', () => {
  it('passes a plan that matches the layouts, unchanged', () => {
    const plan: DeckPlan = {
      slides: [
        slide([
          { placeholder: 'title', kind: 'text', text: 'Hello' },
          {
            placeholder: '1',
            kind: 'bullets',
            bullets: [{ text: 'One', level: 0 }],
          },
        ]),
      ],
    };
    const checked = checkDeckPlan(plan, LAYOUTS);
    expect(checked.blocking).toEqual([]);
    expect(checked.repaired).toEqual([]);
    expect(checked.plan).toEqual(plan);
  });

  it('repairs what needs no judgement, and says what it did', () => {
    const checked = checkDeckPlan(
      {
        slides: [
          slide([
            {
              placeholder: 'title',
              kind: 'bullets',
              bullets: [
                { text: 'Joined', level: 0 },
                { text: 'lines', level: 0 },
              ],
            },
            { placeholder: '9', kind: 'text', text: 'Nowhere' },
            {
              placeholder: '1',
              kind: 'bullets',
              bullets: [{ text: 'Deep', level: 7 }],
            },
            { placeholder: '1', kind: 'text', text: 'Twice' },
          ]),
          slide([{ placeholder: 'title', kind: 'text', text: '   ' }]),
          slide([
            { placeholder: 'title', kind: 'text', text: 'Picture' },
            { placeholder: '1', kind: 'image', image: 'unknown', alt: '' },
          ]),
        ],
      },
      LAYOUTS,
    );
    expect(checked.blocking).toEqual([]);
    expect(checked.repaired.map((p) => [p.code, p.slide])).toEqual([
      ['kind-not-accepted', 1],
      ['unknown-placeholder', 1],
      ['bullet-level', 1],
      ['repeated-placeholder', 1],
      ['empty-fill', 2],
      ['empty-slide', 2],
      ['unknown-image', 3],
    ]);
    expect(checked.plan.slides).toHaveLength(2);
    expect(checked.plan.slides[0].fills).toEqual([
      { placeholder: 'title', kind: 'text', text: 'Joined lines' },
      {
        placeholder: '1',
        kind: 'bullets',
        bullets: [{ text: 'Deep', level: 4 }],
      },
    ]);
  });

  it('keeps a picture that was given', () => {
    const checked = checkDeckPlan(
      {
        slides: [
          slide([
            {
              placeholder: '1',
              kind: 'image',
              image: 'logo:main',
              alt: 'Logo',
            },
          ]),
        ],
      },
      LAYOUTS,
      new Set(['logo:main']),
    );
    expect(checked.repaired).toEqual([]);
    expect(checked.plan.slides[0].fills).toHaveLength(1);
  });

  it('blocks what needs judgement: unknown layouts, sideways text, text past the fit', () => {
    const tooLong = 'x'.repeat(14 * 6);
    const checked = checkDeckPlan(
      {
        slides: [
          slide([{ placeholder: 'title', kind: 'text', text: 'A' }], 'nope'),
          slide(
            [{ placeholder: 'title', kind: 'text', text: 'B' }],
            'slideLayout10',
          ),
          slide([
            { placeholder: 'title', kind: 'text', text: 'C' },
            { placeholder: '1', kind: 'text', text: tooLong },
          ]),
        ],
      },
      LAYOUTS,
    );
    expect(checked.blocking.map((p) => [p.code, p.slide])).toEqual([
      ['unknown-layout', 1],
      ['vertical-layout', 2],
      ['too-long', 3],
    ]);
    expect(checked.blocking[2].message).toContain('holds 4 lines');
  });

  it('notes text the fit will shrink, without blocking it', () => {
    const checked = checkDeckPlan(
      {
        slides: [
          slide([
            { placeholder: 'title', kind: 'text', text: 'Shrinks' },
            { placeholder: '1', kind: 'text', text: 'x'.repeat(50) },
          ]),
        ],
      },
      LAYOUTS,
    );
    expect(checked.blocking).toEqual([]);
    expect(checked.shrunk).toEqual([{ slide: 1, placeholder: '1' }]);
  });

  it('keeps the first slides of a long plan, and blocks an empty one', () => {
    const many = checkDeckPlan(
      {
        slides: Array.from({ length: MAX_PLAN_SLIDES + 2 }, () =>
          slide([{ placeholder: 'title', kind: 'text', text: 'T' }]),
        ),
      },
      LAYOUTS,
    );
    expect(many.plan.slides).toHaveLength(MAX_PLAN_SLIDES);
    expect(many.repaired[0].code).toBe('too-many-slides');
    expect(checkDeckPlan({ slides: [] }, LAYOUTS).blocking[0].code).toBe(
      'no-slides',
    );
  });

  it('offers planners only layouts with something to fill, none sideways', () => {
    expect(plannableLayouts(LAYOUTS).map((layout) => layout.id)).toEqual([
      'slideLayout2',
    ]);
  });
});
