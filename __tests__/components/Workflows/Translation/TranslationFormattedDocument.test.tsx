import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import {
  fetchNativePdfAvailability,
  renderNativePdf,
  runNativePdf,
} from '@/client/services/workflows/nativePdfTranslation';

import { NativePdfRunReport } from '@/lib/utils/shared/translation/nativePdf';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream: vi.fn() }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('@/client/services/workflows/nativePdfTranslation', () => ({
  fetchNativePdfAvailability: vi.fn(),
  runNativePdf: vi.fn(),
  renderNativePdf: vi.fn(),
  reviseNativePdfUnit: vi.fn(),
  fetchNativePdfImage: vi.fn(() => Promise.resolve('data:image/png;base64,')),
}));
// The browser PDF renderer is not available in jsdom.
vi.mock('@/client/hooks/workflows/usePdfPages', () => ({
  usePdfPages: (_load: unknown, fileKey: string | null) => ({
    status: fileKey ? 'ready' : 'idle',
    pageCount: fileKey ? PAGE_COUNT : 0,
    renderPage: () => Promise.resolve('data:image/png;base64,'),
  }),
}));
// Keys are rendered as-is, with their values appended, so assertions name
// the string and what it was given.
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

const PAGE_COUNT = 5;
/** Pages one request takes. */
const MAX_PAGES = 2;
/**
 * The person's limits: 2 pages a batch by default, 3 at most, 4 of the
 * 5-page document in total, so every page state can be reached.
 */
const LIMITS = { defaultBatchPages: 2, maxBatchPages: 3, maxDocumentPages: 4 };
const SOURCE_URL = '/api/file/manual.pdf';

const report: NativePdfRunReport = {
  steps: [],
  pageCount: PAGE_COUNT,
  pages: [{ page: 1, width: 500, height: 700, units: 1, scanned: false }],
  units: [
    {
      id: 'p1u1',
      page: 1,
      n: 1,
      role: 'title',
      note: '',
      source: 'Annual report',
      bbox: [50, 50, 300, 80],
      room: [50, 50, 400, 90],
      budgetChars: 40,
      translation: 'Informe anual',
      scale: 1,
      fits: true,
      tagsRepaired: false,
      refitted: false,
    },
  ],
  issues: [],
  uncheckedPages: [],
  fonts: { sans: 'Sans', serif: 'Serif' },
  refitRounds: 0,
  pdfUrl: '/api/file/out.pdf',
  pageImages: [{ page: 1, previewUrl: '/api/file/p1.png', checkUrl: '' }],
  sourceId: 'source-id',
  unitsId: 'units-id',
} as NativePdfRunReport;

/** Pages of a selection such as "1-2" or "3, 5". */
function pagesOf(selection: string): number[] {
  return selection.split(',').flatMap((part) => {
    const [from, to = from] = part.trim().split('-').map(Number);
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
  });
}

/** A finished request: one fitted unit per page asked for. */
function reportFor(selection: string): NativePdfRunReport {
  const pages = pagesOf(selection);
  return {
    ...report,
    pages: pages.map((page) => ({ ...report.pages[0], page })),
    units: pages.map((page) => ({
      ...report.units[0],
      id: `p${page}u1`,
      page,
      translation: page === 1 ? 'Informe anual' : `Página ${page}`,
    })),
    pageImages: pages.map((page) => ({
      page,
      previewUrl: `/api/file/p${page}.png`,
      checkUrl: '',
    })),
    unitsId: `units-${pages.join('-')}`,
  };
}

/** What a render answers when it lays out the given units. */
function renderAnswer(
  ids: string[],
  extra: Partial<Awaited<ReturnType<typeof renderNativePdf>>> = {},
) {
  return {
    fits: ids.map((id) => ({
      id,
      page: Number(id.slice(1, id.indexOf('u'))),
      n: 1,
      scale: 1,
      fits: true,
    })),
    issues: [],
    checkedPages: [],
    uncheckedPages: [],
    fonts: report.fonts,
    repaired: [],
    tooLong: [],
    pdfUrl: '/api/file/out2.pdf',
    pageImages: [],
    unitsId: 'units-all',
    ...extra,
  };
}

const pageStates = () =>
  [...document.querySelectorAll('[data-page-state]')].map((element) =>
    element.getAttribute('data-page-state'),
  );
const batchSummary = () => screen.getByTestId('batch-summary').textContent;

function workflowState(): TranslationWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as TranslationWorkflowState;
}

function mountWorkspace(overrides: Partial<TranslationWorkflowState> = {}) {
  const state: TranslationWorkflowState = {
    kind: 'translation',
    sourceText: 'extracted source text',
    sourceDocument: {
      name: 'manual.pdf',
      url: SOURCE_URL,
      lastPage: PAGE_COUNT,
      selectedPages: `1-${PAGE_COUNT}`,
    },
    targetLanguage: { id: 'es', label: 'Spanish' },
    mode: 'document',
    rounds: [],
    finalText: '',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  useConversationStore.setState({
    conversations: [
      {
        id: 'formatted',
        name: 'Document',
        messages: [],
        model: {
          id: 'gpt-4',
          name: 'GPT-4',
          maxLength: 4000,
          tokenLimit: 4000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        conversationType: 'translation',
        workflowState: state,
      } as unknown as Conversation,
    ],
    selectedConversationId: 'formatted',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TranslationWorkspace conversationId="formatted" />
    </QueryClientProvider>,
  );
}

const layoutGroup = () =>
  screen.findByRole('radiogroup', {
    name: 'translation.formatted.optionsLayout',
  });
const depthGroup = () =>
  screen.queryByRole('radiogroup', {
    name: 'translation.formatted.optionsDepth',
  });
const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .filter((radio) => radio.getAttribute('aria-checked') === 'true')
    .map((radio) => radio.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchNativePdfAvailability).mockResolvedValue({
    enabled: true,
    maxPages: MAX_PAGES,
    maxRefitRounds: 2,
    limits: LIMITS,
  });
  // Each request answers with one unit per page it was asked for.
  vi.mocked(runNativePdf).mockImplementation(async (input) => ({
    report: reportFor(input.pages),
    totalTokens: 123,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url === SOURCE_URL
          ? new Response('%PDF-1.4')
          : Response.json({ data: { guides: [] } }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('document mode: layout options', () => {
  it('defaults to text only and shows no translation choice for it', async () => {
    mountWorkspace();
    expect(checked(await layoutGroup())).toEqual([
      'translation.formatted.layoutText',
    ]);
    expect(depthGroup()).toBeNull();
    expect(
      screen.queryByText('translation.formatted.whatHappensTitle'),
    ).toBeNull();
  });

  it('offers no layout choice when the service is off', async () => {
    vi.mocked(fetchNativePdfAvailability).mockResolvedValue({
      enabled: false,
      maxPages: 0,
      maxRefitRounds: 0,
      limits: LIMITS,
    });
    mountWorkspace({ documentLayout: 'formatted' });
    await waitFor(() => expect(fetchNativePdfAvailability).toHaveBeenCalled());
    expect(
      screen.queryByRole('radiogroup', {
        name: 'translation.formatted.optionsLayout',
      }),
    ).toBeNull();
    expect(
      screen.queryByText('translation.formatted.whatHappensTitle'),
    ).toBeNull();
  });

  it('is not offered outside document mode', async () => {
    mountWorkspace({ mode: 'quick', documentLayout: 'formatted' });
    await waitFor(() => expect(fetchNativePdfAvailability).toHaveBeenCalled());
    expect(
      screen.queryByRole('radiogroup', {
        name: 'translation.formatted.optionsLayout',
      }),
    ).toBeNull();
  });

  it('opens the setup with a quick translation when formatting is chosen', async () => {
    mountWorkspace();
    fireEvent.click(
      within(await layoutGroup()).getByRole('radio', {
        name: 'translation.formatted.layoutFormatted',
      }),
    );
    expect(workflowState().documentLayout).toBe('formatted');
    expect(checked(depthGroup() as HTMLElement)).toEqual([
      'translation.modeQuick',
    ]);
    expect(
      screen.getByText('translation.formatted.whatHappensTitle'),
    ).toBeTruthy();
  });
});

describe('document mode: preserve formatting', () => {
  it('fills the batch from the first pages and shows the rest as waiting', async () => {
    mountWorkspace({ documentLayout: 'formatted' });
    await screen.findByText('translation.formatted.whatHappensTitle');
    await waitFor(() =>
      expect(batchSummary()).toBe('translation.formatted.batchSummary 2 2'),
    );
    // Batch of 2 of a 5-page document, 4 allowed in total: the batch is
    // full, and the limit still leaves room for a later one.
    expect(pageStates()).toEqual([
      'selected',
      'selected',
      'later',
      'later',
      'later',
    ]);
    // Only pages that can be ticked have a checkbox.
    expect(
      screen.getAllByRole('checkbox', {
        name: /translation\.formatted\.pageLabel/,
      }),
    ).toHaveLength(2);
    expect(workflowState().formattedOptions).toBeUndefined();
  });

  it('frees a slot when a page is unticked, and offers the others for it', async () => {
    mountWorkspace({ documentLayout: 'formatted' });
    const boxes = await screen.findAllByRole('checkbox', {
      name: /translation\.formatted\.pageLabel/,
    });
    fireEvent.click(boxes[1]);
    expect(workflowState().formattedOptions?.pages).toBe('1');
    expect(pageStates()).toEqual([
      'selected',
      'available',
      'available',
      'available',
      'available',
    ]);
  });

  it('lets the person raise the batch up to the largest one, not beyond', async () => {
    mountWorkspace({ documentLayout: 'formatted' });
    const size = await screen.findByLabelText(
      'translation.formatted.batchSize',
    );
    expect(
      within(size)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['1', '2', '3']);
    fireEvent.change(size, { target: { value: '3' } });
    expect(workflowState().formattedOptions?.batchPages).toBe(3);
    expect(batchSummary()).toBe('translation.formatted.batchSummary 3 3');
    // 3 of the 4 allowed pages are in this batch: one more can follow.
    expect(pageStates()).toEqual([
      'selected',
      'selected',
      'selected',
      'later',
      'later',
    ]);
  });

  it('refuses a typed selection larger than the batch', async () => {
    mountWorkspace({
      documentLayout: 'formatted',
      formattedOptions: { pages: '1-3', instructions: {}, refitRounds: 1 },
    });
    expect(
      await screen.findByText('translation.formatted.pagesOverBatch 3 2'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'translation.formatted.translatePages 0',
      }),
    ).toBeDisabled();
  });

  it('runs the translation with the chosen options and shows the result', async () => {
    mountWorkspace({ documentLayout: 'formatted', documentDepth: 'reviewed' });
    const start = await screen.findByRole('button', {
      name: `translation.formatted.translatePages ${MAX_PAGES}`,
    });
    fireEvent.click(start);
    await waitFor(() => expect(runNativePdf).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runNativePdf).mock.calls[0][0]).toMatchObject({
      targetLanguage: 'Spanish',
      depth: 'reviewed',
      pages: '1-2',
      conversationId: 'formatted',
    });
    await waitFor(() =>
      expect(workflowState().formattedRun?.sourceUrl).toBe(SOURCE_URL),
    );
    // One request, nothing to join.
    expect(renderNativePdf).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('link', {
        name: 'translation.formatted.download',
      }),
    ).toBeTruthy();
  });

  it('sends a batch larger than one request in parts and joins them', async () => {
    vi.mocked(renderNativePdf).mockResolvedValue(
      renderAnswer(['p1u1', 'p2u1', 'p3u1']),
    );
    mountWorkspace({
      documentLayout: 'formatted',
      formattedOptions: {
        pages: '',
        batchPages: 3,
        instructions: {},
        refitRounds: 1,
      },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.translatePages 3',
      }),
    );
    await waitFor(() => expect(renderNativePdf).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(runNativePdf).mock.calls.map(([input]) => input.pages),
    ).toEqual(['1-2', '3']);
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      unitsIds: ['units-1-2', 'units-3'],
      checkPages: [],
      imagePages: [],
    });
    await waitFor(() =>
      expect(workflowState().formattedRun?.unitsId).toBe('units-all'),
    );
    const run = workflowState().formattedRun;
    expect(run?.units.map((unit) => unit.page)).toEqual([1, 2, 3]);
    expect(run?.pageImages.map((image) => image.page)).toEqual([1, 2, 3]);
    expect(run?.pdfUrl).toBe('/api/file/out2.pdf');
    expect(run?.totalTokens).toBe(246);
  });

  it('adds a second batch to the first and marks what is left', async () => {
    vi.mocked(renderNativePdf).mockResolvedValue(
      renderAnswer(['p1u1', 'p2u1', 'p3u1', 'p4u1']),
    );
    mountWorkspace({ documentLayout: 'formatted' });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.translatePages 2',
      }),
    );
    await waitFor(() => expect(workflowState().formattedRun).toBeDefined());

    // The finished result offers the way on.
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.addPages',
      }),
    );
    expect(
      screen.getByText('translation.formatted.earlierAdding 2 Spanish'),
    ).toBeTruthy();
    // 2 done, 2 more allowed and both in this batch: page 5 is beyond the
    // document limit, not merely waiting.
    expect(pageStates()).toEqual([
      'translated',
      'translated',
      'selected',
      'selected',
      'locked',
    ]);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'translation.formatted.translatePages 2',
      }),
    );
    await waitFor(() => expect(renderNativePdf).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runNativePdf).mock.calls[1][0].pages).toBe('3-4');
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      sourceId: 'source-id',
      unitsIds: ['units-1-2', 'units-3-4'],
    });
    await waitFor(() =>
      expect(workflowState().formattedRun?.unitsId).toBe('units-all'),
    );
    expect(
      workflowState().formattedRun?.units.map((unit) => unit.page),
    ).toEqual([1, 2, 3, 4]);
    expect(workflowState().formattedRun?.batches).toBe(2);
    // The limit is used up: there is nothing left to add, only to redo.
    expect(
      await screen.findByRole('button', {
        name: 'translation.formatted.translateAgain',
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'translation.formatted.addPages' }),
    ).toBeNull();
  });

  it('starts over instead of adding when asked', async () => {
    mountWorkspace({ documentLayout: 'formatted' });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.translatePages 2',
      }),
    );
    await waitFor(() => expect(workflowState().formattedRun).toBeDefined());
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.addPages',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.formatted.startOver' }),
    );
    expect(
      screen.getByText('translation.formatted.earlierReplacing 2'),
    ).toBeTruthy();
    expect(pageStates().slice(0, 2)).toEqual(['selected', 'selected']);
  });

  it('holds a typed edit until the pages are re-rendered', async () => {
    vi.mocked(renderNativePdf).mockResolvedValue(
      renderAnswer(['p1u1', 'p2u1'], {
        checkedPages: [1],
        pageImages: [
          { page: 1, previewUrl: '/api/file/p1b.png', checkUrl: '' },
        ],
        unitsId: 'units-1-2',
      }),
    );
    mountWorkspace({ documentLayout: 'formatted' });
    fireEvent.click(
      await screen.findByRole('button', {
        name: `translation.formatted.translatePages ${MAX_PAGES}`,
      }),
    );
    await waitFor(() => expect(workflowState().formattedRun).toBeDefined());
    fireEvent.click(await screen.findByText('Informe anual'));
    // One edit, two places: the field on the page and the one in the list.
    const fields = screen.getAllByDisplayValue('Informe anual');
    expect(fields).toHaveLength(2);
    fireEvent.change(fields[0], { target: { value: 'Memoria anual' } });
    expect(screen.getAllByDisplayValue('Memoria anual')).toHaveLength(2);
    expect(workflowState().formattedRun?.edits).toEqual({
      p1u1: 'Memoria anual',
    });
    expect(workflowState().formattedRun?.units[0].translation).toBe(
      'Informe anual',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.formatted.rerender' }),
    );
    await waitFor(() =>
      expect(workflowState().formattedRun?.pdfUrl).toBe('/api/file/out2.pdf'),
    );
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      sourceId: 'source-id',
      unitsIds: ['units-1-2'],
      translations: { p1u1: 'Memoria anual', p2u1: 'Página 2' },
      // Only the edited page is drawn again.
      imagePages: [1],
    });
    expect(workflowState().formattedRun?.edits).toEqual({});
    expect(workflowState().formattedRun?.units[0].translation).toBe(
      'Memoria anual',
    );
    // The page that did not change keeps its image.
    expect(workflowState().formattedRun?.pageImages).toEqual([
      { page: 1, previewUrl: '/api/file/p1b.png', checkUrl: '' },
      { page: 2, previewUrl: '/api/file/p2.png', checkUrl: '' },
    ]);
  });

  it('points at the language control instead of doing nothing without one', async () => {
    mountWorkspace({ documentLayout: 'formatted', targetLanguage: undefined });
    const start = await screen.findByRole('button', {
      name: `translation.formatted.translatePages ${MAX_PAGES}`,
    });
    const language = screen.getByRole('button', {
      name: 'translation.chooseLanguage',
    });
    // Marked before anything is pressed: it is the only thing missing.
    expect(language).toHaveAttribute('data-needs-language', 'true');
    expect(screen.getByText('translation.languageNeeded')).not.toHaveAttribute(
      'role',
    );
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(runNativePdf).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'translation.languageNeeded',
    );
  });

  it('names what is missing instead of the setup for a file that is not a PDF', async () => {
    mountWorkspace({
      documentLayout: 'formatted',
      sourceDocument: {
        name: 'manual.docx',
        url: '/api/file/manual.docx',
        lastPage: 1,
        selectedPages: '1',
      },
    });
    expect(
      await screen.findByText('translation.formatted.needsPdf'),
    ).toBeTruthy();
    expect(
      screen.queryByText('translation.formatted.whatHappensTitle'),
    ).toBeNull();
  });
});
