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

const PAGE_COUNT = 3;
const MAX_PAGES = 2;
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
  });
  vi.mocked(runNativePdf).mockResolvedValue({ report, totalTokens: 123 });
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
  it('selects no more pages than one run takes', async () => {
    mountWorkspace({ documentLayout: 'formatted' });
    // Empty selection = the first pages, up to the limit.
    expect(
      await screen.findByText(
        `translation.formatted.pagesSelected ${MAX_PAGES} ${PAGE_COUNT} ${MAX_PAGES}`,
      ),
    ).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox', {
      name: /translation\.formatted\.pageLabel/,
    });
    expect(boxes).toHaveLength(PAGE_COUNT);
    fireEvent.click(boxes[PAGE_COUNT - 1]);
    expect(
      screen.getByText(`translation.formatted.pagesLimit ${MAX_PAGES}`),
    ).toBeTruthy();
    expect(workflowState().formattedOptions).toBeUndefined();
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
      pages: '',
      conversationId: 'formatted',
    });
    await waitFor(() =>
      expect(workflowState().formattedRun?.sourceUrl).toBe(SOURCE_URL),
    );
    expect(
      await screen.findByRole('link', {
        name: 'translation.formatted.download',
      }),
    ).toBeTruthy();
  });

  it('holds a typed edit until the pages are re-rendered', async () => {
    vi.mocked(renderNativePdf).mockResolvedValue({
      fits: [{ id: 'p1u1', page: 1, n: 1, scale: 1, fits: true }],
      issues: [],
      checkedPages: [1],
      uncheckedPages: [],
      fonts: report.fonts,
      repaired: [],
      tooLong: [],
      pdfUrl: '/api/file/out2.pdf',
      pageImages: report.pageImages,
    });
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
      unitsId: 'units-id',
      translations: { p1u1: 'Memoria anual' },
    });
    expect(workflowState().formattedRun?.edits).toEqual({});
    expect(workflowState().formattedRun?.units[0].translation).toBe(
      'Memoria anual',
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
