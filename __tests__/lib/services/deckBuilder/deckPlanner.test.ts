import {
  DECK_SOURCE_TYPES,
  deckPictures,
  deckTemplateType,
  parseDeckUpload,
} from '@/lib/services/deckBuilder/deckInputs';
import {
  describeBrandVoice,
  describeLayouts,
  planDeck,
  planFromRaw,
} from '@/lib/services/deckBuilder/deckPlanner';
import { callStructured } from '@/lib/services/workflows/shared/workflowLlm';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import type {
  DeckLayouts,
  DeckPlaceholder,
} from '@/lib/utils/shared/documents/deckPlan';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Planning a deck with a model, and what a deck may be built from. */

vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  callStructured: vi.fn(),
  createAzureClient: () => ({}),
}));

const place = (
  key: string,
  role: DeckPlaceholder['role'],
  vertical = false,
): DeckPlaceholder => ({
  key,
  role,
  accepts:
    role === 'title'
      ? ['text']
      : role === 'picture'
        ? ['image']
        : ['text', 'bullets', 'image'],
  name: key,
  box: [0, 0, 100, 100],
  size: 24,
  lines: role === 'title' ? 1 : 6,
  charsPerLine: 30,
  vertical,
});

const LAYOUTS: DeckLayouts = {
  slideSize: { width: 720, height: 540 },
  slideCount: 1,
  layouts: [
    {
      id: 'slideLayout2',
      name: 'Title and Content',
      type: 'obj',
      master: 'm',
      placeholders: [place('title', 'title'), place('1', 'content')],
    },
    {
      id: 'slideLayout7',
      name: 'Blank',
      type: 'blank',
      master: 'm',
      placeholders: [],
    },
    {
      id: 'slideLayout10',
      name: 'Vertical',
      type: 'vertTx',
      master: 'm',
      placeholders: [place('title', 'title'), place('1', 'body', true)],
    },
  ],
};

const raw = (layout: string, title: string) => ({
  slides: [
    {
      layout,
      notes: '',
      fills: [
        {
          placeholder: 'title',
          kind: 'text',
          text: title,
          bullets: [],
          image: '',
          alt: '',
        },
        {
          placeholder: '1',
          kind: 'bullets',
          text: 'ignored',
          bullets: [{ text: 'One', level: 9 }],
          image: 'ignored',
          alt: '',
        },
      ],
    },
  ],
});

const input = () => ({
  brief: 'Board update',
  sources: [{ name: 'notes.docx', text: 'We opened three clinics.' }],
  layouts: LAYOUTS,
  pictures: [
    { key: 'logo:main', name: 'Main logo', kind: 'logo' as const, file: 'x' },
  ],
  book: null,
  language: 'fr',
  model: 'model-x',
  usage: {} as never,
});

describe('planDeck', () => {
  beforeEach(() => vi.mocked(callStructured).mockReset());

  it('shows the model only plannable layouts, with their room, in the deck’s language', async () => {
    vi.mocked(callStructured).mockResolvedValueOnce(
      raw('slideLayout2', 'Hello'),
    );
    const checked = await planDeck(input());
    expect(checked.blocking).toEqual([]);
    expect(callStructured).toHaveBeenCalledTimes(1);
    const { user } = vi.mocked(callStructured).mock.calls[0][0];
    expect(user).toContain('Write the deck in French.');
    expect(user).toContain('slideLayout2 "Title and Content"');
    expect(user).toContain(
      '1 (content): text, bullets, a picture; 6 lines of about 30 characters',
    );
    expect(user).not.toContain('Blank');
    expect(user).not.toContain('slideLayout10');
    expect(user).toContain('logo:main: Main logo (the brand’s logo)');
    expect(user).toContain('We opened three clinics.');
  });

  it('asks once more with the problems in words, and takes the repaired plan', async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(raw('slideLayout99', 'Hello'))
      .mockResolvedValueOnce(raw('slideLayout2', 'Hello'));
    const checked = await planDeck(input());
    expect(callStructured).toHaveBeenCalledTimes(2);
    const repair = vi.mocked(callStructured).mock.calls[1][0];
    expect(repair.user).toContain('which the template does not have');
    expect(repair.usageLabel).toBe('deck-plan-repair');
    expect(checked.blocking).toEqual([]);
    expect(checked.plan.slides[0].layout).toBe('slideLayout2');
  });

  it('returns what still blocks after the repair, rather than failing', async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(raw('slideLayout99', 'A'))
      .mockResolvedValueOnce(raw('slideLayout10', 'B'));
    const checked = await planDeck(input());
    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(checked.blocking.map((problem) => problem.code)).toEqual([
      'unknown-layout',
    ]);
  });
});

describe('what the planner is told', () => {
  it('takes from the model only what each kind uses', () => {
    const plan = planFromRaw(raw('slideLayout2', 'Hello') as never);
    expect(plan.slides[0].fills).toEqual([
      { placeholder: 'title', kind: 'text', text: 'Hello' },
      {
        placeholder: '1',
        kind: 'bullets',
        bullets: [{ text: 'One', level: 4 }],
      },
    ]);
  });

  it('states the brand’s voice: tone, words to use and words to avoid', () => {
    const parsed = parseBrandBookBody({
      name: 'Northwind',
      language: {
        tone: 'Warm.',
        preferred: [{ term: 'families', alternatives: ['clients'] }],
        banned: [{ term: 'cheap', alternatives: ['affordable'] }],
      },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const voice = describeBrandVoice(parsed.body);
    expect(voice).toContain('Tone: Warm.');
    expect(voice).toContain('Write "families" rather than "clients".');
    expect(voice).toContain('Never write "cheap"; write "affordable".');
    expect(describeBrandVoice(null)).toBe('');
  });

  it('describes a picture placeholder without room for text', () => {
    expect(
      describeLayouts([
        {
          id: 'slideLayout9',
          name: 'Picture with Caption',
          type: 'picTx',
          master: 'm',
          placeholders: [place('1', 'picture')],
        },
      ]),
    ).toBe('slideLayout9 "Picture with Caption":\n  - 1 (picture): a picture');
  });
});

describe('what a deck is built from', () => {
  const book = parseBrandBookBody({
    name: 'Northwind',
    templates: [
      {
        id: 'deck',
        name: 'Deck',
        type: 'potx',
        file: `admin:brand-aaaaaaaaaaaa/${'c'.repeat(32)}.potx`,
      },
      {
        id: 'letter',
        name: 'Letter',
        type: 'dotx',
        file: `admin:brand-aaaaaaaaaaaa/${'d'.repeat(32)}.dotx`,
      },
    ],
    logos: [
      {
        id: 'main',
        name: 'Main logo',
        file: `admin:brand-aaaaaaaaaaaa/${'e'.repeat(32)}.png`,
      },
      {
        id: 'vector',
        name: 'Vector logo',
        file: `admin:brand-aaaaaaaaaaaa/${'f'.repeat(32)}.svg`,
      },
    ],
  });
  if (!book.ok) throw new Error(book.error);

  it('takes a book’s deck template, or the person’s .pptx or .potx', () => {
    expect(deckTemplateType(book.body.templates[0].file, book.body)).toBe(
      'potx',
    );
    // The book's Word template, and a file the book does not list, are not.
    expect(deckTemplateType(book.body.templates[1].file, book.body)).toBeNull();
    expect(
      deckTemplateType(
        `admin:brand-bbbbbbbbbbbb/${'c'.repeat(32)}.potx`,
        book.body,
      ),
    ).toBeNull();
    expect(deckTemplateType(book.body.templates[0].file, null)).toBeNull();
    expect(deckTemplateType(`/api/file/${'a'.repeat(64)}.pptx`, null)).toBe(
      'pptx',
    );
    expect(
      deckTemplateType(`/api/file/${'a'.repeat(64)}.pdf`, null),
    ).toBeNull();
  });

  it('offers the book’s placeable logos, then the person’s pictures, by key', () => {
    const pictures = deckPictures(book.body, [
      { file: `/api/file/${'a'.repeat(64)}.png`, name: 'Clinic.png' },
    ]);
    expect(pictures.map((picture) => [picture.key, picture.kind])).toEqual([
      ['logo:main', 'logo'],
      ['picture:1', 'picture'],
    ]);
  });

  it('reads only well-formed uploads of an allowed type', () => {
    expect(
      parseDeckUpload(`/api/file/${'a'.repeat(64)}.docx`, DECK_SOURCE_TYPES),
    ).toEqual({
      id: `${'a'.repeat(64)}.docx`,
      type: 'docx',
    });
    expect(
      parseDeckUpload(`/api/file/${'a'.repeat(64)}.exe`, DECK_SOURCE_TYPES),
    ).toBeNull();
    expect(
      parseDeckUpload('/api/file/../x.docx', DECK_SOURCE_TYPES),
    ).toBeNull();
  });
});
