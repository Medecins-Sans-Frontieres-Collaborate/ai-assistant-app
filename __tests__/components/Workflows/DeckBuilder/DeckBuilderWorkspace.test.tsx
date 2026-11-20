import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { NextIntlClientProvider } from 'next-intl';

import {
  listUsableBrandBooks,
  readBrandReview,
} from '@/client/services/brand/brandReview';
import {
  readDeckWork,
  startDeckBuild,
  startDeckOutline,
} from '@/client/services/deckBuilder/deckBuilder';
import type {
  DeckBuildState,
  DeckOutlineState,
} from '@/lib/services/deckBuilder/deckBuilderJobs';

import type {
  DeckLayouts,
  DeckPlaceholder,
} from '@/lib/utils/shared/documents/deckPlan';

import { DeckBuilderWorkspace } from '@/components/Workflows/DeckBuilder/DeckBuilderWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import messages from '@/messages/en.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Deck builder workspace against the real English messages: setting a
 * deck up, editing its outline (with the capacity check the server uses),
 * and the built deck with its brand findings.
 */

vi.unmock('next-intl');
vi.mock('@/client/services/brand/brandBookAdmin', () => ({
  uploadBrandFile: vi.fn(),
}));
vi.mock('@/client/services/brand/brandReview', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listUsableBrandBooks: vi.fn(),
  readBrandReview: vi.fn(),
}));
vi.mock(
  '@/client/services/deckBuilder/deckBuilder',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    startDeckOutline: vi.fn(),
    startDeckBuild: vi.fn(),
    readDeckWork: vi.fn(),
    stopDeckWork: vi.fn(),
    removeDeckWork: vi.fn(async () => undefined),
  }),
);
vi.mock('@/client/services/documents/documentPdf', () => ({
  fetchDocumentPdf: vi.fn(),
}));
vi.mock('@/components/Documents/DocumentViewer', () => ({
  DocumentViewer: ({ aside }: { aside: ReactNode }) => (
    <div data-testid="viewer">{aside}</div>
  ),
}));

const CONVERSATION = 'conv-deck';
const BOOK = 'brand-aaaaaaaaaaaa';
const TEMPLATE = `admin:${BOOK}/${'c'.repeat(32)}.potx`;
const DECK = `/api/file/${'d'.repeat(64)}.pptx`;
const OUTLINE_ID = 'outline-aaaaaaaaaaaa';
const BUILD_ID = 'deck-bbbbbbbbbbbb';

const place = (
  key: string,
  role: DeckPlaceholder['role'],
  lines: number,
): DeckPlaceholder => ({
  key,
  role,
  accepts:
    role === 'title' || role === 'subtitle'
      ? ['text']
      : ['text', 'bullets', 'image'],
  name: key,
  box: [0, 0, 100, 100],
  size: 24,
  lines,
  charsPerLine: 20,
  vertical: false,
});

const LAYOUTS: DeckLayouts = {
  slideSize: { width: 720, height: 540 },
  slideCount: 1,
  layouts: [
    {
      id: 'slideLayout1',
      name: 'Title Slide',
      type: 'title',
      master: 'slideMaster1',
      placeholders: [place('ctrTitle', 'title', 2), place('1', 'subtitle', 2)],
    },
    {
      id: 'slideLayout2',
      name: 'Title and Content',
      type: 'obj',
      master: 'slideMaster1',
      placeholders: [place('title', 'title', 1), place('1', 'content', 4)],
    },
  ],
};

const base = {
  version: 1,
  jobId: 'j',
  startedAt: Date.parse('2026-11-20T10:00:00Z'),
  heartbeatAt: 0,
  resumes: 0,
};

const outlineState = (): DeckOutlineState => ({
  ...base,
  status: 'done',
  request: {
    template: { file: TEMPLATE, name: 'Northwind deck', type: 'potx' },
    book: { id: BOOK, name: 'Northwind', updatedAt: 'x', body: {} as never },
    brief: 'Board update',
    sources: [],
    pictures: [
      { key: 'logo:main', name: 'Main logo', kind: 'logo', file: 'x' },
    ],
    language: 'en',
  },
  phase: 'planning',
  layouts: LAYOUTS,
  plan: {
    slides: [
      {
        layout: 'slideLayout1',
        fills: [
          { placeholder: 'ctrTitle', kind: 'text', text: 'Annual review' },
        ],
        notes: '',
      },
      {
        layout: 'slideLayout2',
        fills: [
          { placeholder: 'title', kind: 'text', text: 'What we did' },
          {
            placeholder: '1',
            kind: 'bullets',
            bullets: [{ text: 'Opened clinics', level: 0 }],
          },
        ],
        notes: '',
      },
    ],
  },
  repaired: [],
  blocking: [],
  unread: [],
});

const buildState = (): DeckBuildState => ({
  ...base,
  status: 'done',
  request: {
    outlineId: OUTLINE_ID,
    template: { file: TEMPLATE, name: 'Northwind deck', type: 'potx' },
    book: { id: BOOK, name: 'Northwind', updatedAt: 'x', body: {} as never },
    plan: outlineState().plan!,
    pictures: [],
    language: 'en',
    name: 'Annual review',
    noteLocale: 'en',
  },
  phase: 'reviewing',
  file: DECK,
  report: {
    slides: [],
    units: [{ id: 'u', page: 2, n: 1, scale: 0.9, fits: true }],
  },
  reviewId: 'review-cccccccccccc',
  review: { error: 1, warning: 0, info: 0 },
  reviewGap: null,
});

function seed(workflowState: Record<string, unknown>) {
  useConversationStore.setState({
    conversations: [
      {
        id: CONVERSATION,
        name: 'Deck',
        messages: [],
        conversationType: 'deck-builder',
        workflowState: {
          kind: 'deck-builder',
          brief: '',
          sources: [],
          pictures: [],
          updatedAt: '2026-11-20T00:00:00.000Z',
          ...workflowState,
        },
      },
    ],
  } as never);
}

const workflowState = () =>
  useConversationStore.getState().conversations[0].workflowState as Record<
    string,
    unknown
  >;

function renderWorkspace() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        onError={(error) => {
          throw error;
        }}
      >
        <DeckBuilderWorkspace conversationId={CONVERSATION} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('DeckBuilderWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listUsableBrandBooks).mockResolvedValue([
      {
        id: BOOK,
        name: 'Northwind',
        description: '',
        colors: ['#0f7c80'],
        templates: [
          { id: 'deck', name: 'Northwind deck', type: 'potx', file: TEMPLATE },
        ],
        updatedAt: 'x',
      },
    ]);
    vi.mocked(readDeckWork).mockImplementation(async (id: string) =>
      id.startsWith('outline-')
        ? { id, state: outlineState() }
        : { id, state: buildState() },
    );
  });

  it('drafts an outline from a book’s template and a brief', async () => {
    seed({});
    vi.mocked(startDeckOutline).mockResolvedValue({
      id: OUTLINE_ID,
      state: { ...outlineState(), status: 'running', plan: null },
    });
    renderWorkspace();
    const start = screen.getByRole('button', { name: 'Draft outline' });
    fireEvent.click(
      await screen.findByRole('radio', { name: /Northwind deck/ }),
    );
    // A brief is needed before anything is drafted.
    expect(start).toBeDisabled();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'What is the deck for?' }),
      {
        target: { value: 'Board update' },
      },
    );
    fireEvent.click(start);
    expect(
      await screen.findByRole('heading', { name: 'Outline' }),
    ).toBeInTheDocument();
    expect(startDeckOutline).toHaveBeenCalledWith({
      template: { file: TEMPLATE, name: 'Northwind deck' },
      bookId: BOOK,
      brief: 'Board update',
      sources: [],
      pictures: [],
      language: 'en',
    });
    expect(workflowState()).toMatchObject({ outlineId: OUTLINE_ID });
  });

  it('edits the outline with the server’s capacity check, and blocks what cannot fit', async () => {
    seed({ outlineId: OUTLINE_ID });
    renderWorkspace();
    expect(
      await screen.findByText('2 slides, ready to edit'),
    ).toBeInTheDocument();
    const build = screen.getByRole('button', { name: 'Build deck (2 slides)' });
    expect(build).toBeEnabled();

    const slides = screen.getAllByRole('listitem');
    const content = within(slides[1]).getByRole('textbox', { name: 'Content' });
    expect(content).toHaveValue('Opened clinics');
    // Four lines of twenty characters; a 0.7 fit makes room for 5 of 28.
    fireEvent.change(content, { target: { value: 'x'.repeat(28 * 6) } });
    expect(within(slides[1]).getByText(/Too long/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Slide 2 has more text than fits',
    );
    expect(build).toBeDisabled();
    fireEvent.change(content, { target: { value: 'x'.repeat(100) } });
    expect(
      within(slides[1]).getByText(/set smaller to fit/),
    ).toBeInTheDocument();
    expect(build).toBeEnabled();

    // A new layout keeps the title by its role.
    fireEvent.change(
      within(slides[1]).getByRole('combobox', { name: 'Layout of slide 2' }),
      { target: { value: 'slideLayout1' } },
    );
    expect(
      within(screen.getAllByRole('listitem')[1]).getByRole('textbox', {
        name: 'Title',
      }),
    ).toHaveValue('What we did');
  });

  it('builds the deck, then shows it with its brand findings and a download', async () => {
    seed({ outlineId: OUTLINE_ID });
    vi.mocked(startDeckBuild).mockResolvedValue({
      id: BUILD_ID,
      state: {
        ...buildState(),
        status: 'running',
        phase: 'composing',
        file: null,
      },
    });
    vi.mocked(readBrandReview).mockResolvedValue({
      reviewId: 'review-cccccccccccc',
      state: {
        findings: [
          {
            id: 'font:u1:courier',
            rule: 'font',
            severity: 'error',
            page: 1,
            unitId: 'u1',
            imageId: null,
            box: [0, 0, 10, 10],
            found: 'Courier',
            expected: ['Montserrat'],
            source: 'check',
          },
        ],
      },
    } as never);
    renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Build deck (2 slides)' }),
    );
    expect(
      await screen.findByText('1 brand error, no warnings'),
    ).toBeInTheDocument();
    expect(startDeckBuild).toHaveBeenCalledWith({
      outlineId: OUTLINE_ID,
      plan: outlineState().plan,
      name: 'Annual review',
      locale: 'en',
    });
    expect(
      await screen.findByText(
        "Set in Courier; the brand's typefaces are Montserrat.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Text on one slide was set smaller to fit.'),
    ).toBeInTheDocument();
    const download = screen.getByRole('link', { name: 'Download .pptx' });
    expect(download).toHaveAttribute('href', `${DECK}?filetype=file`);
    expect(download).toHaveAttribute('download', 'Annual review.pptx');

    fireEvent.click(screen.getByRole('button', { name: 'Edit outline' }));
    expect(
      await screen.findByRole('button', { name: 'Build deck (2 slides)' }),
    ).toBeInTheDocument();
    expect(workflowState().buildId).toBeUndefined();
  });
});
