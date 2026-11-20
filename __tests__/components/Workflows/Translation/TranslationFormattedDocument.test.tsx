import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import {
  readDeckJob,
  startDeckJob,
} from '@/client/services/workflows/nativeDeckJob';
import {
  fetchNativePdfAvailability,
  renderNativePdf,
  runNativePdf,
} from '@/client/services/workflows/nativePdfTranslation';
import { resetRunSessions } from '@/client/services/workflows/nativeRunSession';
import type * as RunStorageModule from '@/client/services/workflows/nativeRunStorage';
import {
  RunMissingError,
  deleteRun,
  downloadRunFile,
  loadRunRecord,
  syncRun,
} from '@/client/services/workflows/nativeRunStorage';

import { FormattedDocumentRun } from '@/lib/utils/shared/translation/formattedDocument';
import { NativePdfRunReport } from '@/lib/utils/shared/translation/nativePdf';
import type * as RunRulesModule from '@/lib/utils/shared/translation/nativeRunStorage';
import { NativeRunRef } from '@/lib/utils/shared/translation/nativeRunStorage';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream: vi.fn() }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
// Storage is an in-memory record: what the workspace saved last.
let savedRecord: FormattedDocumentRun | undefined;
vi.mock('@/client/services/workflows/nativeRunStorage', async (original) => ({
  ...(await original<typeof RunStorageModule>()),
  newRunAccess: vi.fn((backend: string) =>
    Promise.resolve({ runId: RUN_ID, backend }),
  ),
  saveRunRecord: vi.fn((_access: unknown, run: FormattedDocumentRun) => {
    savedRecord = run;
    return Promise.resolve();
  }),
  loadRunRecord: vi.fn(),
  syncRun: vi.fn(() => Promise.resolve({})),
  deleteRun: vi.fn(() => Promise.resolve(true)),
  fetchRunFile: vi.fn(() => Promise.resolve(new Uint8Array())),
  downloadRunFile: vi.fn(() => Promise.resolve()),
}));
// Changes are saved without the quiet period.
vi.mock(
  '@/lib/utils/shared/translation/nativeRunStorage',
  async (original) => ({
    ...(await original<typeof RunRulesModule>()),
    RUN_SAVE_DELAY_MS: 0,
  }),
);
vi.mock('@/client/services/workflows/nativePdfTranslation', () => ({
  fetchNativePdfAvailability: vi.fn(),
  runNativePdf: vi.fn(),
  renderNativePdf: vi.fn(),
  reviseNativePdfUnit: vi.fn(),
  fetchNativePdfImage: vi.fn(() => Promise.resolve('data:image/png;base64,')),
}));
// A presentation's background job (the server side is tested elsewhere).
vi.mock('@/client/services/workflows/nativeDeckJob', async (original) => ({
  ...(await original<object>()),
  startDeckJob: vi.fn(),
  readDeckJob: vi.fn(),
  stopDeckJob: vi.fn(),
  recordDeckJobUsage: vi.fn(),
}));
// The browser PDF renderer is not available in jsdom.
vi.mock('@/client/hooks/documents/usePdfPages', () => ({
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
      size: 10,
      color: '#02024f',
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

const RUN_ID = '11111111-2222-4333-8444-555555555555';
/** The run as storage last received it. */
const savedRun = (): FormattedDocumentRun | undefined => savedRecord;
/** Lets a pending save reach storage. */
const flushSaves = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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
  savedRecord = undefined;
  resetRunSessions();
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
    await waitFor(() => expect(savedRun()?.sourceUrl).toBe(SOURCE_URL));
    // One request, nothing to join.
    expect(renderNativePdf).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('button', {
        name: 'translation.formatted.downloadMenu',
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
    await waitFor(() => expect(savedRun()?.unitsId).toBe('units-all'));
    await flushSaves();
    const run = savedRun();
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
    await waitFor(() => expect(savedRun()).toBeDefined());

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
    await waitFor(() => expect(savedRun()?.unitsId).toBe('units-all'));
    await flushSaves();
    expect(savedRun()?.units.map((unit) => unit.page)).toEqual([1, 2, 3, 4]);
    await flushSaves();
    expect(savedRun()?.batches).toBe(2);
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
    await waitFor(() => expect(savedRun()).toBeDefined());
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
    await waitFor(() => expect(savedRun()).toBeDefined());
    fireEvent.click(await screen.findByText('Informe anual'));
    // One edit, two places: the field on the page and the one in the list.
    const fields = screen.getAllByDisplayValue('Informe anual');
    expect(fields).toHaveLength(2);
    fireEvent.change(fields[0], { target: { value: 'Memoria anual' } });
    expect(screen.getAllByDisplayValue('Memoria anual')).toHaveLength(2);
    await flushSaves();
    expect(savedRun()?.edits).toEqual({
      p1u1: 'Memoria anual',
    });
    await flushSaves();
    expect(savedRun()?.units[0].translation).toBe('Informe anual');
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.formatted.rerender' }),
    );
    await waitFor(() => expect(savedRun()?.pdfUrl).toBe('/api/file/out2.pdf'));
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      sourceId: 'source-id',
      unitsIds: ['units-1-2'],
      translations: { p1u1: 'Memoria anual', p2u1: 'Página 2' },
      // Only the edited page is drawn again.
      imagePages: [1],
    });
    await flushSaves();
    expect(savedRun()?.edits).toEqual({});
    await flushSaves();
    expect(savedRun()?.units[0].translation).toBe('Memoria anual');
    // The page that did not change keeps its image.
    await flushSaves();
    expect(savedRun()?.pageImages).toEqual([
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

  it('speaks of slides for a presentation, and offers Text only when its run fails', async () => {
    vi.mocked(startDeckJob).mockResolvedValue({
      job: { status: 'running' },
      sourceId: 'a.pptx',
      sourceUrl: '/x',
    } as never);
    vi.mocked(readDeckJob).mockResolvedValue({
      job: {
        status: 'failed',
        error: 'The slides could not be read',
        pieces: [],
        parts: 1,
        pageCount: 2,
        translateNotes: true,
      },
    } as never);
    mountWorkspace({
      documentLayout: 'formatted',
      sourceDocument: {
        name: 'deck.pptx',
        url: '/api/file/deck.pptx',
        lastPage: PAGE_COUNT,
        selectedPages: `1-${PAGE_COUNT}`,
      },
    });
    const start = await screen.findByRole('button', {
      name: `translation.formatted.slides.translatePages ${MAX_PAGES}`,
    });
    // The notes option shows in this layout too, ticked by default.
    expect(
      screen.getAllByRole('checkbox', {
        name: 'translation.formatted.speakerNotes',
      })[0],
    ).toBeChecked();
    fireEvent.click(start);
    await waitFor(() => expect(startDeckJob).toHaveBeenCalledTimes(1));
    expect(runNativePdf).not.toHaveBeenCalled();
    expect(vi.mocked(startDeckJob).mock.calls[0][0]).toMatchObject({
      translateNotes: true,
      pages: '1-2',
    });
    const fallback = await screen.findByRole('button', {
      name: 'translation.formatted.slides.useTextOnly',
    });
    expect(
      screen.getByText(
        /translation\.formatted\.runFailed The slides could not be read/,
      ),
    ).toBeTruthy();
    fireEvent.click(fallback);
    await waitFor(() => expect(workflowState().documentLayout).toBe('text'));
  });

  it('names what is missing instead of the setup for a file it cannot keep the formatting of', async () => {
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
      await screen.findByText('translation.formatted.needsSupportedFile'),
    ).toBeTruthy();
    expect(
      screen.queryByText('translation.formatted.whatHappensTitle'),
    ).toBeNull();
  });
});

describe('finished translation: the page list', () => {
  const pageLooks = () =>
    [...document.querySelectorAll('[data-page-look]')].map((element) =>
      element.getAttribute('data-page-look'),
    );
  const railStates = () =>
    [...document.querySelectorAll('[data-page-look]')].map((element) =>
      element.getAttribute('data-page-state'),
    );
  const button = (name: string) => screen.getByRole('button', { name });

  /** Translates pages 1-2 of the 5-page document and waits for the result. */
  async function finishFirstBatch() {
    mountWorkspace({ documentLayout: 'formatted' });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.translatePages 2',
      }),
    );
    await waitFor(() => expect(savedRun()).toBeDefined());
    await screen.findByRole('button', {
      name: 'translation.formatted.removePage 5',
    });
  }

  it('lists every page of the document, telling translated from not', async () => {
    await finishFirstBatch();
    expect(pageLooks()).toEqual([
      'translated',
      'translated',
      'untranslated',
      'untranslated',
      'untranslated',
    ]);
    expect(
      screen.getAllByText('translation.formatted.pageUntranslated'),
    ).toHaveLength(3);
  });

  it('shows an untranslated page as its original, with a way to translate it', async () => {
    await finishFirstBatch();
    fireEvent.click(button('translation.formatted.pageLabel 3'));
    await flushSaves();
    expect(savedRun()?.page).toBe(3);
    const panel = screen.getByTestId('untranslated-panel');
    expect(panel).toHaveTextContent(
      'translation.formatted.pageUntranslatedNote',
    );
    fireEvent.click(
      within(panel).getByRole('button', {
        name: 'translation.formatted.translateThisPage',
      }),
    );
    await waitFor(() => expect(runNativePdf).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runNativePdf).mock.calls[1][0].pages).toBe('3');
  });

  it('selects the next batch and adds it to the document', async () => {
    vi.mocked(renderNativePdf).mockResolvedValue(
      renderAnswer(['p1u1', 'p2u1', 'p3u1', 'p4u1']),
    );
    await finishFirstBatch();
    fireEvent.click(button('translation.formatted.railSelectNext 2'));
    // 2 done and 2 ticked use the limit of 4 up: page 5 is beyond it.
    expect(railStates()).toEqual([
      'translated',
      'translated',
      'selected',
      'selected',
      'locked',
    ]);
    expect(screen.getByTestId('rail-batch-summary')).toHaveTextContent(
      'translation.formatted.batchSummary 2 2',
    );
    fireEvent.click(button('translation.formatted.translatePages 2'));
    await waitFor(() => expect(renderNativePdf).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runNativePdf).mock.calls[1][0]).toMatchObject({
      pages: '3-4',
      depth: 'quick',
    });
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      unitsIds: ['units-1-2', 'units-3-4'],
      omitPages: [],
    });
    await waitFor(() =>
      expect(savedRun()?.units.map((unit) => unit.page)).toEqual([1, 2, 3, 4]),
    );
  });

  it('ticks pages one by one up to the batch, and frees a place on untick', async () => {
    await finishFirstBatch();
    const tick = (page: number) =>
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: `translation.formatted.pageLabel ${page}`,
        }),
      );
    tick(5);
    expect(railStates().slice(2)).toEqual([
      'available',
      'available',
      'selected',
    ]);
    tick(3);
    // The batch of 2 is full: page 4 has no tick box any more.
    expect(railStates().slice(2)).toEqual(['selected', 'locked', 'selected']);
    expect(
      screen.queryByRole('checkbox', {
        name: 'translation.formatted.pageLabel 4',
      }),
    ).toBeNull();
    tick(5);
    expect(railStates().slice(2)).toEqual([
      'selected',
      'available',
      'available',
    ]);
    fireEvent.click(button('translation.formatted.railClear'));
    expect(railStates().slice(2)).toEqual([
      'available',
      'available',
      'available',
    ]);
  });

  it('removes a page from the download only once the download is updated', async () => {
    vi.mocked(renderNativePdf).mockResolvedValue(
      renderAnswer(['p1u1', 'p2u1'], { unitsId: 'units-1-2' }),
    );
    await finishFirstBatch();
    expect(screen.queryByTestId('pending-changes')).toBeNull();
    fireEvent.click(button('translation.formatted.removePage 5'));
    expect(pageLooks()[4]).toBe('removed');
    await flushSaves();
    expect(savedRun()?.removedPages).toEqual([5]);
    // Still the old file until it is built again.
    await flushSaves();
    expect(savedRun()?.pdfUrl).toBe('/api/file/out.pdf');
    expect(screen.getByTestId('pending-changes')).toHaveTextContent(
      'translation.formatted.pagesPending',
    );
    expect(
      screen.getByText('translation.formatted.pdfBehindPages'),
    ).toBeTruthy();

    fireEvent.click(button('translation.formatted.updateDownload'));
    await waitFor(() => expect(savedRun()?.pdfUrl).toBe('/api/file/out2.pdf'));
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      omitPages: [5],
      // Nothing was edited: no page is drawn or checked again.
      imagePages: [],
      checkPages: [],
    });
    await flushSaves();
    expect(savedRun()?.pdfRemovedPages).toEqual([5]);
    expect(screen.queryByTestId('pending-changes')).toBeNull();
  });

  it('puts a removed page back, and undoes page changes not yet in the download', async () => {
    await finishFirstBatch();
    fireEvent.click(button('translation.formatted.removePage 4'));
    fireEvent.click(button('translation.formatted.removePage 1'));
    expect(pageLooks()).toEqual([
      'removed',
      'translated',
      'untranslated',
      'removed',
      'untranslated',
    ]);
    fireEvent.click(button('translation.formatted.restorePage 4'));
    await flushSaves();
    expect(savedRun()?.removedPages).toEqual([1]);
    fireEvent.click(button('translation.formatted.undoPageChanges'));
    await flushSaves();
    expect(savedRun()?.removedPages ?? []).toEqual([]);
    expect(screen.queryByTestId('pending-changes')).toBeNull();
    expect(renderNativePdf).not.toHaveBeenCalled();
  });

  it('keeps a removed page out of the next batch', async () => {
    await finishFirstBatch();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'translation.formatted.pageLabel 3',
      }),
    );
    fireEvent.click(button('translation.formatted.removePage 3'));
    // Its tick went with it, and the next batch starts after it.
    expect(railStates().slice(2)).toEqual([
      'removed',
      'available',
      'available',
    ]);
    fireEvent.click(button('translation.formatted.railSelectNext 2'));
    expect(railStates().slice(2)).toEqual(['removed', 'selected', 'selected']);
  });

  it('never lets the last page go', async () => {
    await finishFirstBatch();
    for (const page of [1, 2, 3, 4]) {
      fireEvent.click(button(`translation.formatted.removePage ${page}`));
    }
    await flushSaves();
    expect(savedRun()?.removedPages).toEqual([1, 2, 3, 4]);
    expect(
      screen.queryByRole('button', {
        name: 'translation.formatted.removePage 5',
      }),
    ).toBeNull();
  });

  it('says why pages cannot be added in another language', async () => {
    await finishFirstBatch();
    useConversationStore.setState((store) => ({
      conversations: store.conversations.map((conversation) => ({
        ...conversation,
        workflowState: {
          ...(conversation.workflowState as TranslationWorkflowState),
          targetLanguage: { id: 'fr', label: 'French' },
        },
      })),
    }));
    expect(
      await screen.findByText(
        'translation.formatted.railOtherLanguage Spanish',
      ),
    ).toBeTruthy();
    expect(screen.queryAllByRole('checkbox', { name: /pageLabel/ })).toEqual(
      [],
    );
  });
});

describe('finished translation: zoom and the look of a block', () => {
  const button = (name: string) => screen.getByRole('button', { name });

  async function finishOnePage() {
    mountWorkspace({
      documentLayout: 'formatted',
      formattedOptions: { pages: '1', instructions: {}, refitRounds: 0 },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.translatePages 1',
      }),
    );
    await waitFor(() => expect(savedRun()).toBeDefined());
    await screen.findByTestId('formatted-page');
  }
  const pageWidth = () => screen.getByTestId('formatted-page').style.width;
  const zoomLevel = () => screen.getByTestId('zoom-level').textContent;

  it('zooms the page in and out by steps, and back to normal', async () => {
    await finishOnePage();
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 100');
    const normal = pageWidth();
    fireEvent.click(button('translation.formatted.zoomIn'));
    fireEvent.click(button('translation.formatted.zoomIn'));
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 150');
    expect(pageWidth()).toContain('1.5');
    expect(pageWidth()).not.toBe(normal);
    fireEvent.click(button('translation.formatted.zoomReset'));
    expect(pageWidth()).toBe(normal);
    fireEvent.click(button('translation.formatted.zoomOut'));
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 75');
  });

  it('stops at the largest and the smallest zoom', async () => {
    await finishOnePage();
    const zoomIn = button('translation.formatted.zoomIn');
    for (
      let press = 0;
      press < 12 && !zoomIn.hasAttribute('disabled');
      press += 1
    ) {
      fireEvent.click(zoomIn);
    }
    expect(zoomIn).toBeDisabled();
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 250');
    fireEvent.click(button('translation.formatted.zoomReset'));
    const zoomOut = button('translation.formatted.zoomOut');
    fireEvent.click(zoomOut);
    fireEvent.click(zoomOut);
    expect(zoomOut).toBeDisabled();
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 50');
  });

  it("changes a block's size, position and colour, pending until re-rendered", async () => {
    vi.mocked(renderNativePdf).mockResolvedValue(
      renderAnswer(['p1u1'], { unitsId: 'units-1' }),
    );
    await finishOnePage();
    // While a block is selected its outline gives way to the edit field.
    const boxBefore = (
      await screen.findByRole('button', {
        name: 'translation.formatted.blockLabel 1',
      })
    ).style.left;
    fireEvent.click(await screen.findByText('Informe anual'));
    const look = screen.getByTestId('block-style');
    // The source's own look is what the controls start from.
    expect(look).toHaveTextContent('translation.formatted.styleSizeValue 10');

    fireEvent.click(button('translation.formatted.styleLarger'));
    fireEvent.click(button('translation.formatted.styleLarger'));
    fireEvent.click(button('translation.formatted.moveRight'));
    fireEvent.click(button('translation.formatted.moveUp'));
    fireEvent.change(
      screen.getByLabelText('translation.formatted.styleColorOf 1'),
      { target: { value: '#ff0000' } },
    );
    await flushSaves();
    expect(savedRun()?.styles).toEqual({
      p1u1: { size: 11, dx: 2, dy: -2, color: '#ff0000' },
    });
    expect(look).toHaveTextContent('translation.formatted.styleSizeValue 11');
    expect(look).toHaveTextContent('translation.formatted.styleOffset +2 −2');
    expect(look).toHaveTextContent('translation.formatted.styleNote');
    // One block changed, however many things about it.
    expect(screen.getByTestId('pending-changes')).toHaveTextContent(
      'translation.formatted.editsPending 1',
    );
    // The PDF is the old one still.
    await flushSaves();
    expect(savedRun()?.pdfUrl).toBe('/api/file/out.pdf');
    // The outline shows where the block will go before anything is rendered.
    fireEvent.click(button('translation.formatted.done'));
    expect(button('translation.formatted.blockLabel 1').style.left).not.toBe(
      boxBefore,
    );

    fireEvent.click(button('translation.formatted.rerender'));
    await waitFor(() => expect(savedRun()?.pdfUrl).toBe('/api/file/out2.pdf'));
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      styles: { p1u1: { size: 11, dx: 2, dy: -2, color: '#ff0000' } },
      // The restyled block's page is drawn again.
      imagePages: [1],
    });
    await flushSaves();
    expect(savedRun()?.pdfStyles).toEqual({
      p1u1: { size: 11, dx: 2, dy: -2, color: '#ff0000' },
    });
    expect(screen.queryByTestId('pending-changes')).toBeNull();
  });

  it("resets one block's look, and discards pending looks with the edits", async () => {
    await finishOnePage();
    fireEvent.click(await screen.findByText('Informe anual'));
    fireEvent.click(button('translation.formatted.styleSmaller'));
    await flushSaves();
    expect(savedRun()?.styles).toEqual({
      p1u1: { size: 9.5 },
    });
    fireEvent.click(button('translation.formatted.styleReset'));
    await flushSaves();
    expect(savedRun()?.styles).toEqual({});
    expect(screen.queryByTestId('pending-changes')).toBeNull();

    fireEvent.click(button('translation.formatted.moveDown'));
    expect(screen.getByTestId('pending-changes')).toBeTruthy();
    fireEvent.click(button('translation.formatted.discard'));
    await flushSaves();
    expect(savedRun()?.styles ?? {}).toEqual({});
    expect(screen.queryByTestId('pending-changes')).toBeNull();
    expect(renderNativePdf).not.toHaveBeenCalled();
  });

  it('shows a block the automatic fixes adjusted, and lets the person take the fix back', async () => {
    vi.mocked(runNativePdf).mockImplementation(async (input) => ({
      report: {
        ...reportFor(input.pages),
        styles: { p1u1: { size: 9, dy: 4 } },
      },
      totalTokens: 123,
    }));
    vi.mocked(renderNativePdf).mockResolvedValue(
      renderAnswer(['p1u1'], { unitsId: 'units-1' }),
    );
    await finishOnePage();
    // On the page already: marked, and nothing waits to be rendered.
    expect(screen.getByTestId('adjusted-chip')).toBeTruthy();
    expect(screen.queryByTestId('pending-changes')).toBeNull();

    fireEvent.click(await screen.findByText('Informe anual'));
    const look = screen.getByTestId('block-style');
    expect(look).toHaveTextContent('translation.formatted.styleSizeValue 9');
    expect(look).toHaveTextContent('translation.formatted.styleOffset 0 +4');
    expect(look).not.toHaveTextContent('translation.formatted.styleNote');

    fireEvent.click(button('translation.formatted.styleReset'));
    expect(look).toHaveTextContent('translation.formatted.styleSizeValue 10');
    expect(screen.getByTestId('pending-changes')).toBeTruthy();
    fireEvent.click(button('translation.formatted.rerender'));
    await waitFor(() =>
      expect(vi.mocked(renderNativePdf).mock.calls[0]?.[0]).toMatchObject({
        styles: {},
      }),
    );
  });
});

describe('finished translation: keyboard and mouse', () => {
  const button = (name: string) => screen.getByRole('button', { name });
  const zoomLevel = () => screen.getByTestId('zoom-level').textContent;
  const scroller = () => screen.getByTestId('page-scroller');
  const currentPage = () =>
    document
      .querySelector('nav [aria-current="page"]')
      ?.getAttribute('aria-label');
  const pageBlock = () =>
    screen.getByRole('button', { name: 'translation.formatted.blockLabel 1' });
  const listBlock = (id: string) =>
    document.querySelector<HTMLElement>(
      `[data-unit-place="list"][data-unit-id="${id}"]`,
    )!;

  beforeEach(() => {
    // jsdom lays nothing out; the review only takes keys while it has boxes
    // (ownsKeyboard), as it does on screen.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
      new DOMRect(0, 0, 100, 100),
    ] as unknown as DOMRectList);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById('elsewhere')?.remove();
  });

  /** Translates pages 1-2 of the 5-page document and waits for page 1. */
  async function finishTwoPages() {
    mountWorkspace({
      documentLayout: 'formatted',
      formattedOptions: { pages: '1-2', instructions: {}, refitRounds: 0 },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.translatePages 2',
      }),
    );
    await waitFor(() => expect(savedRun()).toBeDefined());
    await screen.findByTestId('formatted-page');
  }

  it('zooms the page, not the browser, with Ctrl or Cmd and +, - and 0', async () => {
    await finishTwoPages();
    pageBlock().focus();
    // fireEvent answers false when the event was prevented: the browser
    // does not zoom the whole app as well.
    expect(fireEvent.keyDown(pageBlock(), { key: '=', ctrlKey: true })).toBe(
      false,
    );
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 125');
    fireEvent.keyDown(pageBlock(), { key: '+', metaKey: true });
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 150');
    fireEvent.keyDown(pageBlock(), { key: '-', ctrlKey: true });
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 125');
    expect(fireEvent.keyDown(pageBlock(), { key: '0', ctrlKey: true })).toBe(
      false,
    );
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 100');
    // Without Ctrl, + is just a key.
    fireEvent.keyDown(pageBlock(), { key: '=' });
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 100');
  });

  it('leaves Ctrl and + to the browser while the keyboard is elsewhere in the app', async () => {
    await finishTwoPages();
    const elsewhere = document.createElement('button');
    elsewhere.id = 'elsewhere';
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(fireEvent.keyDown(elsewhere, { key: '=', ctrlKey: true })).toBe(
      true,
    );
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 100');
  });

  it('zooms with Ctrl+wheel (and a pinch) over the page, and scrolls without Ctrl', async () => {
    await finishTwoPages();
    expect(fireEvent.wheel(scroller(), { deltaY: -100, ctrlKey: true })).toBe(
      false,
    );
    // 100 pixels up is a little over a fifth larger (wheelPageZoom).
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 122');
    // The next step goes on from there to the next level.
    fireEvent.click(button('translation.formatted.zoomIn'));
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 125');
    expect(fireEvent.wheel(scroller(), { deltaY: -100 })).toBe(true);
    expect(zoomLevel()).toBe('translation.formatted.zoomLevel 125');
  });

  it('closes the field on the page with Escape, back to the block', async () => {
    await finishTwoPages();
    fireEvent.click(pageBlock());
    const field = screen.getByLabelText('translation.formatted.editOnPage 1');
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(
      screen.queryByLabelText('translation.formatted.editOnPage 1'),
    ).toBeNull();
    expect(document.activeElement).toBe(pageBlock());
  });

  it('opens a block chosen in the list with the keyboard in the list, and Escape returns there', async () => {
    await finishTwoPages();
    fireEvent.click(listBlock('p1u1'));
    const field = screen.getByLabelText('translation.formatted.translation');
    // The keyboard stays on the side the block was chosen from.
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(document.activeElement).toBe(listBlock('p1u1'));
  });

  it('closes the ask box with Escape, leaving the block open', async () => {
    await finishTwoPages();
    fireEvent.click(pageBlock());
    const [ask] = screen.getAllByRole('button', {
      name: 'translation.formatted.ask',
    });
    fireEvent.click(ask);
    const box = screen.getByLabelText('translation.formatted.askPlaceholder');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(
      screen.queryByLabelText('translation.formatted.askPlaceholder'),
    ).toBeNull();
    expect(document.activeElement).toBe(ask);
    expect(
      screen.getByLabelText('translation.formatted.editOnPage 1'),
    ).toBeTruthy();
  });

  it("marks a block's state on its number in the list, not with a stripe", async () => {
    await finishTwoPages();
    const numberLook = () =>
      document
        .querySelector('ul [data-number-look]')
        ?.getAttribute('data-number-look');
    expect(numberLook()).toBe('plain');
    fireEvent.click(listBlock('p1u1'));
    expect(numberLook()).toBe('selected');
    const field = screen.getByLabelText('translation.formatted.translation');
    fireEvent.change(field, { target: { value: 'Informe del año' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(numberLook()).toBe('edited');
    expect(document.querySelector('ul [class*="border-s-"]')).toBeNull();
  });

  it('makes the page list one Tab stop that the arrows move through', async () => {
    await finishTwoPages();
    const page = (n: number) => button(`translation.formatted.pageLabel ${n}`);
    const tabStops = () =>
      [1, 2, 3, 4, 5].filter((n) => page(n).tabIndex === 0);
    expect(tabStops()).toEqual([1]);
    page(1).focus();
    fireEvent.keyDown(page(1), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(page(2));
    expect(tabStops()).toEqual([2]);
    // The page's own controls follow the Tab stop.
    expect(button('translation.formatted.removePage 2').tabIndex).toBe(0);
    expect(button('translation.formatted.removePage 1').tabIndex).toBe(-1);
    fireEvent.keyDown(page(2), { key: 'End' });
    expect(document.activeElement).toBe(page(5));
    // Moving is not opening: Enter (a click) opens.
    expect(currentPage()).toBe('translation.formatted.pageLabel 1');
  });

  it('switches between the original and the translation with the arrow keys', async () => {
    await finishTwoPages();
    const radio = (name: string) => screen.getByRole('radio', { name });
    const translatedSide = radio('translation.formatted.viewTranslated');
    expect(translatedSide.tabIndex).toBe(0);
    fireEvent.keyDown(translatedSide, { key: 'ArrowLeft' });
    const originalSide = radio('translation.formatted.viewOriginal');
    expect(originalSide).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(originalSide);
    expect(originalSide.tabIndex).toBe(0);
    fireEvent.keyDown(originalSide, { key: 'ArrowRight' });
    expect(translatedSide).toHaveAttribute('aria-checked', 'true');
  });

  it('goes to the next page with PageDown at the end of the page, not while typing', async () => {
    await finishTwoPages();
    fireEvent.click(pageBlock());
    const field = screen.getByLabelText('translation.formatted.editOnPage 1');
    fireEvent.keyDown(field, { key: 'PageDown' });
    expect(currentPage()).toBe('translation.formatted.pageLabel 1');
    fireEvent.keyDown(field, { key: 'Escape' });
    // jsdom scrolls nothing, so the page is always at its end.
    scroller().focus();
    expect(fireEvent.keyDown(scroller(), { key: 'PageDown' })).toBe(false);
    expect(currentPage()).toBe('translation.formatted.pageLabel 2');
    fireEvent.keyDown(scroller(), { key: 'PageUp' });
    expect(currentPage()).toBe('translation.formatted.pageLabel 1');
    // Before the first page there is none to go to.
    expect(fireEvent.keyDown(scroller(), { key: 'PageUp' })).toBe(true);
  });
});

describe('TranslationWorkspace — where a formatted translation is kept', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const fromNow = (days: number) =>
    new Date(Date.now() + days * DAY_MS).toISOString();
  const runRef = (extra: Partial<NativeRunRef> = {}): NativeRunRef => ({
    runId: RUN_ID,
    backend: 'app',
    sourceUrl: SOURCE_URL,
    sourceId: 'source.pdf',
    ...extra,
  });

  /** Translates pages 1-2 and waits for the review. */
  async function translateOnce() {
    mountWorkspace({ documentLayout: 'formatted' });
    fireEvent.click(
      await screen.findByRole('button', {
        name: `translation.formatted.translatePages ${MAX_PAGES}`,
      }),
    );
    await waitFor(() => expect(savedRun()).toBeDefined());
  }

  /** Opens a conversation whose run is in storage. */
  async function reopen(ref: NativeRunRef) {
    await translateOnce();
    const record = savedRun() as FormattedDocumentRun;
    vi.mocked(loadRunRecord).mockResolvedValue(record);
    // Another visit: nothing of the run is in memory.
    resetRunSessions();
    document.body.innerHTML = '';
    mountWorkspace({ documentLayout: 'formatted', formattedRunRef: ref });
  }

  it('keeps only a reference in the browser, and the run in storage', async () => {
    await translateOnce();
    const state = workflowState();
    // Microsoft 365 files are on here, so the run goes to OneDrive.
    expect(state.formattedRunRef).toEqual({
      runId: RUN_ID,
      backend: 'onedrive',
      sourceUrl: SOURCE_URL,
      sourceId: savedRun()?.sourceId,
    });
    // Nothing of the run's content is in workflow state.
    expect(JSON.stringify(state)).not.toContain('Informe anual');
    expect(savedRun()?.units[0].translation).toBe('Informe anual');
    await waitFor(() => expect(syncRun).toHaveBeenCalled());
    // The run is already in memory: it is not read back from storage.
    expect(loadRunRecord).not.toHaveBeenCalled();
  });

  it('uses app storage for someone who does not use Microsoft 365', async () => {
    useSettingsStore.setState({ m365Connected: false });
    try {
      await translateOnce();
      expect(vi.mocked(runNativePdf).mock.calls[0][0].run.backend).toBe('app');
      expect(workflowState().formattedRunRef?.backend).toBe('app');
    } finally {
      useSettingsStore.setState({ m365Connected: true });
    }
  });

  it('falls back to app storage when OneDrive cannot be used', async () => {
    vi.mocked(runNativePdf).mockRejectedValueOnce(
      Object.assign(new Error('Consent is missing'), {
        code: 'M365_CONSENT_MISSING',
      }),
    );
    await translateOnce();
    const backends = vi
      .mocked(runNativePdf)
      .mock.calls.map(([input]) => input.run.backend);
    expect(backends).toEqual(['onedrive', 'app']);
    expect(workflowState().formattedRunRef?.backend).toBe('app');
  });

  it('loads a stored run when the conversation is opened again', async () => {
    await reopen(runRef());
    expect(
      await screen.findByRole('button', {
        name: 'translation.formatted.downloadMenu',
      }),
    ).toBeInTheDocument();
    // Looking at a run asks when it expires without extending it.
    await waitFor(() =>
      expect(syncRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ runId: RUN_ID }),
        expect.any(Array),
        false,
      ),
    );
  });

  it('warns two days before the files expire, not three', async () => {
    await reopen(runRef({ expiresAt: fromNow(3) }));
    await screen.findByTestId('run-storage');
    expect(screen.queryByTestId('run-expiry-warning')).toBeNull();

    document.body.innerHTML = '';
    vi.mocked(syncRun).mockResolvedValue({ expiresAt: fromNow(1.5) });
    mountWorkspace({
      documentLayout: 'formatted',
      formattedRunRef: runRef({ runId: RUN_ID.replace(/^1/, '2') }),
    });
    const warning = await screen.findByTestId('run-expiry-warning');
    expect(warning).toHaveTextContent(
      'translation.formatted.storage.expiresSoon 2',
    );

    // Keeping it touches the files and clears the warning.
    vi.mocked(syncRun).mockResolvedValue({ expiresAt: fromNow(5) });
    fireEvent.click(within(warning).getByRole('button'));
    await waitFor(() =>
      expect(screen.queryByTestId('run-expiry-warning')).toBeNull(),
    );
    expect(vi.mocked(syncRun).mock.lastCall?.[2]).toBeUndefined();
  });

  it('says so when the files are gone, and lets the document be translated again', async () => {
    vi.mocked(loadRunRecord).mockRejectedValue(new RunMissingError());
    mountWorkspace({ documentLayout: 'formatted', formattedRunRef: runRef() });
    const notice = await screen.findByTestId('run-unavailable');
    expect(notice).toHaveTextContent(
      'translation.formatted.storage.missingTitle',
    );
    fireEvent.click(
      within(notice).getByRole('button', {
        name: 'translation.formatted.storage.startOver',
      }),
    );
    expect(workflowState().formattedRunRef).toBeUndefined();
    expect(deleteRun).toHaveBeenCalled();
    expect(
      await screen.findByRole('button', {
        name: `translation.formatted.translatePages ${MAX_PAGES}`,
      }),
    ).toBeInTheDocument();
  });

  it('downloads the PDF through the app, so an encrypted one is readable', async () => {
    await translateOnce();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.formatted.downloadMenu',
      }),
    );
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: /translation\.formatted\.downloadPdf/,
      }),
    );
    await waitFor(() =>
      expect(downloadRunFile).toHaveBeenCalledWith(
        '/api/file/out.pdf',
        'manual_es.pdf',
      ),
    );
    // Nothing had to be built for the PDF.
    expect(renderNativePdf).not.toHaveBeenCalled();
  });

  it('builds the PowerPoint file on request, marks it experimental and keeps it for the next download', async () => {
    await translateOnce();
    vi.mocked(renderNativePdf).mockResolvedValueOnce({
      fits: [],
      issues: [],
      checkedPages: [],
      uncheckedPages: [],
      fonts: { sans: 'Sans', serif: 'Serif' },
      repaired: [],
      tooLong: [],
      pdfUrl: '/api/file/out2.pdf',
      exportUrls: { pptx: '/api/file/out2.pptx' },
      pageImages: [],
      unitsId: 'units',
    });
    const openMenu = async () =>
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'translation.formatted.downloadMenu',
        }),
      );
    const powerPoint = () =>
      screen.findByRole('menuitem', {
        name: /translation\.formatted\.downloadPptx/,
      });
    await openMenu();
    expect((await powerPoint()).textContent).toContain(
      'translation.formatted.experimental',
    );
    fireEvent.click(await powerPoint());
    await waitFor(() =>
      expect(downloadRunFile).toHaveBeenCalledWith(
        '/api/file/out2.pptx',
        'manual_es.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    );
    expect(renderNativePdf).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderNativePdf).mock.calls[0][0]).toMatchObject({
      exports: ['pptx'],
      checkPages: [],
    });
    // The file describes the page as it stands, so it is not built again.
    await openMenu();
    fireEvent.click(await powerPoint());
    await waitFor(() => expect(downloadRunFile).toHaveBeenCalledTimes(2));
    expect(renderNativePdf).toHaveBeenCalledTimes(1);
  });
});
