import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { CORRECTION_SAVE_DELAY_MS } from '@/client/hooks/workflows/useDocumentTranslationReader';

import { Conversation } from '@/types/chat';
import {
  TranslationDocumentJob,
  TranslationWorkflowState,
} from '@/types/workflow';

import { DocumentReaderBar } from '@/components/Workflows/Translation/DocumentReaderBar';
import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream: vi.fn() }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
// Keys are rendered as-is, with their values appended, so assertions name
// the string and what it was given.
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

const PAGE_COUNT = 7;
const JOB_ID = 'job-1';
const fetchMock = vi.fn();
let corrections: Record<number, string>;
/** Extra fields a page carries (a presentation's hidden flag and notes). */
let pageExtras: (page: number) => Record<string, unknown>;
let submitResponse: () => Response;

const envelope = (data: unknown, status = 200) =>
  Response.json({ success: true, data }, { status });

function pagesResponse(from: number, to: number) {
  const last = Math.min(to, PAGE_COUNT);
  const pages = [];
  for (let page = from; page <= last; page += 1) {
    pages.push({
      page,
      source: `source page ${page}`,
      translation: `machine page ${page}`,
      ...pageExtras(page),
      ...(corrections[page] !== undefined && {
        correction: { text: corrections[page], updatedAt: 'then' },
      }),
    });
  }
  return envelope({
    jobId: JOB_ID,
    pageCount: PAGE_COUNT,
    pagesAligned: true,
    from,
    to: last,
    pages,
    correctedPages: Object.keys(corrections).map(Number),
  });
}

const readyJob: TranslationDocumentJob = {
  jobId: JOB_ID,
  status: 'ready',
  submittedAt: '2026-11-14T10:00:00.000Z',
  sourceName: 'manual.pdf',
  translatedFilename: 'manual_es.pdf',
  fileExtension: 'pdf',
  targetLanguage: 'es',
  expiresAt: '2026-11-21T10:00:00.000Z',
  pageCount: PAGE_COUNT,
  page: 1,
};

function workflowState(): TranslationWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as TranslationWorkflowState;
}

function mountWorkspace(overrides: Partial<TranslationWorkflowState>) {
  const state: TranslationWorkflowState = {
    kind: 'translation',
    sourceText: 'extracted source text',
    sourceDocument: {
      name: 'manual.pdf',
      url: '/api/file/manual.pdf',
      lastPage: PAGE_COUNT,
      selectedPages: `1-${PAGE_COUNT}`,
    },
    targetLanguage: { id: 'es', label: 'Spanish' },
    mode: 'document',
    rounds: [],
    finalText: 'text mode result',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  useConversationStore.setState({
    conversations: [
      {
        id: 'doc-mode',
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
    selectedConversationId: 'doc-mode',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TranslationWorkspace conversationId="doc-mode" />
    </QueryClientProvider>,
  );
}

const putCalls = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(init.body as string));

beforeEach(() => {
  vi.clearAllMocks();
  corrections = {};
  pageExtras = () => ({});
  submitResponse = () =>
    envelope(
      {
        async: true,
        jobId: 'job-new',
        originalFilename: 'manual.pdf',
        translatedFilename: 'manual_es.pdf',
        targetLanguage: 'es',
        fileExtension: 'pdf',
        submittedAt: new Date().toISOString(),
      },
      202,
    );
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/document-translation/pages/')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        if (body.text === null) delete corrections[body.page];
        else corrections[body.page] = body.text;
        return Promise.resolve(
          envelope({
            page: body.page,
            correctedPages: Object.keys(corrections).map(Number),
          }),
        );
      }
      const query = new URL(url, 'http://test').searchParams;
      return Promise.resolve(
        pagesResponse(Number(query.get('from')), Number(query.get('to'))),
      );
    }
    if (url.startsWith('/api/document-translation/status/')) {
      return Promise.resolve(envelope({ status: 'Running' }));
    }
    if (url === '/api/document-translation/translate') {
      return Promise.resolve(submitResponse());
    }
    if (url === '/api/file/manual.pdf') {
      return Promise.resolve(new Response('%PDF-1.4'));
    }
    if (url.startsWith('/api/file/')) {
      return Promise.resolve(new Response('PK'));
    }
    return Promise.resolve(Response.json({ data: { guides: [] } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('whole-document mode: availability', () => {
  it('offers Text or Document, with Quick or Reviewed beneath Text', () => {
    mountWorkspace({ mode: 'quick' });
    const group = (name: string) =>
      within(screen.getByRole('radiogroup', { name }))
        .getAllByRole('radio')
        .map((radio) => [
          radio.textContent,
          radio.getAttribute('aria-checked'),
        ]);
    expect(group('translation.kind')).toEqual([
      ['translation.kindText', 'true'],
      ['translation.modeDocument', 'false'],
    ]);
    expect(group('translation.formatted.optionsDepth')).toEqual([
      ['translation.modeQuick', 'true'],
      ['translation.modeAgentic', 'false'],
    ]);
  });

  it('keeps the text depth while in Document and returns to it', () => {
    mountWorkspace({ mode: 'quick' });
    fireEvent.click(
      screen.getByRole('radio', { name: 'translation.modeDocument' }),
    );
    expect(workflowState()).toMatchObject({
      mode: 'document',
      textMode: 'quick',
    });
    // A document read as text has no Quick / Reviewed choice.
    expect(
      screen.queryByRole('radiogroup', {
        name: 'translation.formatted.optionsDepth',
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('radio', { name: 'translation.kindText' }),
    );
    expect(workflowState().mode).toBe('quick');
    fireEvent.click(
      screen.getByRole('radio', { name: 'translation.modeAgentic' }),
    );
    expect(workflowState().mode).toBe('agentic');
  });

  it('offers to translate a PDF loaded as text as a document', () => {
    mountWorkspace({ mode: 'quick' });
    expect(
      screen.getByText(/^translation\.pdfAsTextOffer/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pdfAsTextKeep' }),
    );
    expect(screen.queryByText(/^translation\.pdfAsTextOffer/)).toBeNull();
    expect(workflowState().mode).toBe('quick');
  });

  it('switches to Document from the offer', () => {
    mountWorkspace({ mode: 'agentic' });
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pdfAsTextSwitch' }),
    );
    expect(workflowState()).toMatchObject({
      mode: 'document',
      textMode: 'agentic',
    });
  });

  it.each([
    [
      'no uploaded file',
      { sourceDocument: undefined },
      'translation.documentNeedsFile',
    ],
    [
      'a non-PDF file',
      {
        sourceDocument: {
          name: 'notes.docx',
          url: '/api/file/notes.docx',
          lastPage: 1,
          selectedPages: '1',
        },
      },
      'translation.documentNeedsPdf',
    ],
    [
      'a custom language',
      { targetLanguage: { id: 'es', label: 'Spanish', custom: true } },
      'translation.documentNeedsLanguage',
    ],
    [
      'a language document translation lacks',
      { targetLanguage: { id: 'zz-none', label: 'Nowhere' } },
      'translation.documentLanguageUnsupported',
    ],
  ] as const)(
    'explains why it cannot start with %s',
    (_label, overrides, key) => {
      mountWorkspace(overrides as Partial<TranslationWorkflowState>);
      expect(screen.getByText(key)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'translation.translateDocument' }),
      ).toBeDisabled();
    },
  );

  it('shows the introduction and no glossary control before a job', () => {
    mountWorkspace({});
    expect(screen.getByText('translation.documentIntro')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /translation.glossariesButton/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    ).toBeEnabled();
  });
});

describe('whole-document mode: submitting', () => {
  it('sends the stored file and follows the job with a progress stepper', async () => {
    mountWorkspace({});
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    );
    await waitFor(() =>
      expect(workflowState().documentJob).toMatchObject({
        jobId: 'job-new',
        status: 'translating',
        page: 1,
      }),
    );
    const submit = fetchMock.mock.calls.find(
      ([url]) => url === '/api/document-translation/translate',
    )!;
    const form = submit[1].body as FormData;
    expect(form.get('targetLanguage')).toBe('es');
    expect((form.get('document') as File).name).toBe('manual.pdf');

    expect(
      await screen.findByRole('list', {
        name: 'translation.documentProgressLabel',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/translation.documentCanLeave/),
    ).toBeInTheDocument();
    // The text-mode result is untouched until a page is shown.
    expect(workflowState().finalText).toBe('text mode result');
  });

  it.each([
    [429, undefined, 'translation.documentLimitReached'],
    [503, 'SERVICE_NOT_CONFIGURED', 'translation.documentUnavailable'],
    [500, undefined, 'translation.documentSubmitFailed boom'],
  ])('reports a %s refusal', async (status, code, expected) => {
    submitResponse = () =>
      Response.json({ success: false, error: 'boom', code }, { status });
    mountWorkspace({});
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    );
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(workflowState().documentJob).toBeUndefined();
  });

  it('asks before replacing a finished translation', async () => {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    );
    expect(
      screen.getByText('translation.documentRetranslateMessage'),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/document-translation/translate',
      ),
    ).toBe(false);
  });
});

describe('whole-document mode: reading', () => {
  it('shows a page on both sides and sets the text-mode result aside', async () => {
    mountWorkspace({ documentJob: readyJob });
    expect(await screen.findByText('machine page 1')).toBeInTheDocument();
    expect(screen.getByTestId('document-source-page')).toHaveTextContent(
      'source page 1',
    );
    expect(workflowState()).toMatchObject({
      finalText: 'machine page 1',
      textModeResult: { finalText: 'text mode result' },
      documentJob: { viewPage: 1 },
    });
    expect(screen.getByText(`translation.pageOf ${PAGE_COUNT}`)).toBeVisible();
  });

  it('turns pages with the buttons and the page field', async () => {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    expect(
      screen.getByRole('button', { name: 'translation.pagePrevious' }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pageNext' }),
    );
    expect(await screen.findByText('machine page 2')).toBeInTheDocument();

    const field = screen.getByLabelText('translation.pageLabel');
    fireEvent.change(field, { target: { value: String(PAGE_COUNT) } });
    fireEvent.submit(field.closest('form')!);
    expect(
      await screen.findByText(`machine page ${PAGE_COUNT}`),
    ).toBeInTheDocument();
    expect(screen.getByTestId('document-source-page')).toHaveTextContent(
      `source page ${PAGE_COUNT}`,
    );
    expect(
      screen.getByRole('button', { name: 'translation.pageNext' }),
    ).toBeDisabled();
  });

  it('refuses a page outside the document', async () => {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    const field = screen.getByLabelText('translation.pageLabel');
    fireEvent.change(field, { target: { value: String(PAGE_COUNT + 1) } });
    fireEvent.submit(field.closest('form')!);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(workflowState().documentJob?.page).toBe(1);
  });

  it('gives the pane back to the text modes on leaving, and returns to the page', async () => {
    mountWorkspace({ documentJob: { ...readyJob, page: 3 } });
    await screen.findByText('machine page 3');

    fireEvent.click(
      screen.getByRole('radio', { name: 'translation.kindText' }),
    );
    expect(await screen.findByText('text mode result')).toBeInTheDocument();
    expect(workflowState()).toMatchObject({
      // No text depth was remembered, so Text opens on its default.
      mode: 'agentic',
      finalText: 'text mode result',
      documentJob: { page: 3 },
    });
    expect(workflowState().textModeResult).toBeUndefined();
    expect(workflowState().documentJob?.viewPage).toBeUndefined();

    fireEvent.click(
      screen.getByRole('radio', { name: 'translation.modeDocument' }),
    );
    expect(await screen.findByText('machine page 3')).toBeInTheDocument();
  });

  it('shows a failed job without a pane to edit', () => {
    mountWorkspace({
      documentJob: { ...readyJob, status: 'failed', error: 'bad pdf' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'translation.documentFailed bad pdf',
    );
    expect(
      screen.getByRole('button', { name: 'translation.editTranslation' }),
    ).toBeDisabled();
  });
});

describe('whole-document mode: corrections', () => {
  async function editPage(text: string) {
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.editTranslation' }),
    );
    fireEvent.change(screen.getByDisplayValue(/page \d/), {
      target: { value: text },
    });
  }

  it('saves an edited page as its correction and marks it corrected', async () => {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    await editPage('corrected page 1');
    expect(screen.getByText('translation.correctedLabel')).toBeInTheDocument();
    await waitFor(
      () => expect(putCalls()).toEqual([{ page: 1, text: 'corrected page 1' }]),
      { timeout: CORRECTION_SAVE_DELAY_MS + 2000 },
    );
    expect(
      await screen.findByText('translation.correctionSaved'),
    ).toBeVisible();
    // The corrected page is listed as a way back to it.
    expect(
      await screen.findByText('translation.correctedPages'),
    ).toBeInTheDocument();
  });

  it('shows a stored correction and restores the machine translation', async () => {
    corrections = { 1: 'stored fix' };
    mountWorkspace({ documentJob: readyJob });
    expect(await screen.findByText('stored fix')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /translation.correctionRestore/ }),
    );
    expect(await screen.findByText('machine page 1')).toBeInTheDocument();
    await waitFor(() => expect(putCalls()).toEqual([{ page: 1, text: null }]), {
      timeout: CORRECTION_SAVE_DELAY_MS + 2000,
    });
    expect(
      screen.queryByText('translation.correctedLabel'),
    ).not.toBeInTheDocument();
  });

  it('does not write a page that was only read', async () => {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pageNext' }),
    );
    await screen.findByText('machine page 2');
    await act(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, CORRECTION_SAVE_DELAY_MS + 200),
        ),
    );
    expect(putCalls()).toEqual([]);
  });
});

describe('whole-document mode: leaving a page with suggestions pending', () => {
  const pendingEdit = {
    id: 'e1',
    criterion: 'accuracy',
    severity: 'major',
    before: 'machine',
    after: 'human',
    reason: 'test',
    status: 'pending',
  };
  async function readerWithSuggestion() {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    act(() => {
      useConversationStore
        .getState()
        .updateWorkflowState('doc-mode', (prev) => ({
          ...(prev as TranslationWorkflowState),
          assessment: {
            criteria: [],
            summary: '',
            edits: [pendingEdit],
          } as never,
        }));
    });
    await waitFor(() =>
      expect(workflowState().assessment?.edits).toHaveLength(1),
    );
  }
  const gate = () => screen.queryByText('translation.pendingLeavePage');

  it('turns the page freely when nothing is pending', async () => {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pageNext' }),
    );
    expect(gate()).toBeNull();
    expect(await screen.findByText('machine page 2')).toBeInTheDocument();
  });

  it('asks first, and stays on the page when cancelled', async () => {
    await readerWithSuggestion();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pageNext' }),
    );
    expect(gate()).toBeInTheDocument();
    expect(workflowState().documentJob?.page).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(gate()).toBeNull();
    expect(workflowState().documentJob?.page).toBe(1);
    expect(workflowState().assessment?.edits[0].status).toBe('pending');
  });

  it('accepting all saves the change as a correction, then turns the page', async () => {
    await readerWithSuggestion();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pageNext' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'acceptAll' }));
    expect(await screen.findByText('machine page 2')).toBeInTheDocument();
    await waitFor(() =>
      expect(putCalls()).toEqual([{ page: 1, text: 'human page 1' }]),
    );
  });

  it('rejecting all turns the page and writes nothing', async () => {
    await readerWithSuggestion();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.pageNext' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'rejectAll' }));
    expect(await screen.findByText('machine page 2')).toBeInTheDocument();
    expect(putCalls()).toEqual([]);
  });

  it('gates leaving the mode the same way', async () => {
    await readerWithSuggestion();
    fireEvent.click(
      screen.getByRole('radio', { name: 'translation.kindText' }),
    );
    expect(gate()).toBeInTheDocument();
    expect(workflowState().mode).toBe('document');
    fireEvent.click(screen.getByRole('button', { name: 'rejectAll' }));
    await waitFor(() => expect(workflowState().mode).toBe('agentic'));
    expect(workflowState().finalText).toBe('text mode result');
  });
});

describe('whole-document mode: what does not apply', () => {
  it('says so when glossaries are attached, and only then', () => {
    const { unmount } = mountWorkspace({});
    expect(
      screen.queryByText(/translation.documentGlossariesIgnored/),
    ).toBeNull();
    unmount();
    mountWorkspace({ glossaryGuideIds: ['org-1', 'org-2'] } as never);
    expect(
      screen.getByText('translation.documentGlossariesIgnored 2'),
    ).toBeInTheDocument();
  });

  it('says a running translation cannot be stopped', () => {
    mountWorkspace({ documentJob: { ...readyJob, status: 'translating' } });
    expect(
      screen.getByText(/translation.documentNoCancel/),
    ).toBeInTheDocument();
  });
});

describe('DocumentReaderBar', () => {
  const corrected = [2, 3, 5, 8, 13, 21, 34, 55];
  const renderBar = (page = 3) => {
    const onGoToPage = vi.fn();
    render(
      <DocumentReaderBar
        job={{ ...readyJob, pageCount: 60, page }}
        correctedPages={corrected}
        saveState="error"
        disabled={false}
        onGoToPage={onGoToPage}
      />,
    );
    return onGoToPage;
  };

  it('links the first corrected pages and counts the rest', () => {
    const onGoToPage = renderBar();
    const links = corrected.slice(0, 6).map(String);
    for (const label of links) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '34' })).toBeNull();
    expect(screen.getByText('translation.correctedPagesMore 2')).toBeVisible();
    expect(screen.getByRole('button', { name: '3' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: '13' }));
    expect(onGoToPage).toHaveBeenCalledWith(13);
  });

  it('reports a failed save and the expiry date', () => {
    renderBar();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('translation.correctionSaveFailed');
    expect(
      within(status.parentElement!).getByText(
        /translation.documentAvailableUntil .*21/,
      ),
    ).toBeInTheDocument();
  });
});

describe('whole-document mode: presentations', () => {
  const deck = {
    name: 'briefing.pptx',
    url: '/api/file/briefing.pptx',
    lastPage: PAGE_COUNT,
    selectedPages: `1-${PAGE_COUNT}`,
  };
  const deckJob: TranslationDocumentJob = {
    ...readyJob,
    sourceName: 'briefing.pptx',
    translatedFilename: 'briefing_es.pptx',
    fileExtension: 'pptx',
  };
  const notesOption = () =>
    screen.queryByRole('checkbox', {
      name: 'translation.formatted.speakerNotes',
    });

  afterEach(() => {
    useSettingsStore.getState().setTranslateSpeakerNotes(true);
  });

  it('offers to translate speaker notes for a presentation only', () => {
    const { unmount } = mountWorkspace({});
    expect(notesOption()).toBeNull();
    unmount();
    mountWorkspace({ sourceDocument: deck });
    expect(notesOption()).toBeChecked();
  });

  it('remembers turning notes off and sends that choice', async () => {
    mountWorkspace({ sourceDocument: deck });
    fireEvent.click(notesOption()!);
    expect(useSettingsStore.getState().translateSpeakerNotes).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/document-translation/translate',
        ),
      ).toBe(true),
    );
    const form = fetchMock.mock.calls.find(
      ([url]) => url === '/api/document-translation/translate',
    )![1].body as FormData;
    expect((form.get('document') as File).name).toBe('briefing.pptx');
    expect(form.get('translateNotes')).toBe('false');
  });

  it('sends no notes field when notes are translated, the default', async () => {
    mountWorkspace({ sourceDocument: deck });
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/document-translation/translate',
        ),
      ).toBe(true),
    );
    const form = fetchMock.mock.calls.find(
      ([url]) => url === '/api/document-translation/translate',
    )![1].body as FormData;
    expect(form.get('translateNotes')).toBeNull();
  });

  it('reads slide by slide, marks a hidden slide and shows its notes', async () => {
    pageExtras = (page) =>
      page === 1
        ? {
            hidden: true,
            sourceNotes: 'Thank the volunteers.',
            translationNotes: 'Agradecer a los voluntarios.',
          }
        : {};
    mountWorkspace({ sourceDocument: deck, documentJob: deckJob });
    await screen.findByText('machine page 1');
    expect(screen.getByText('translation.slides.label')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'translation.slides.next' }),
    ).toBeInTheDocument();
    expect(screen.getByText('translation.slides.hidden')).toBeVisible();
    expect(screen.getByText('translation.slides.notes')).toBeVisible();
    expect(
      screen.getByText('Agradecer a los voluntarios.'),
    ).toBeInTheDocument();
  });

  it('says notes were kept instead of showing them twice', async () => {
    pageExtras = () => ({
      sourceNotes: 'Thank the volunteers.',
      translationNotes: 'Thank the volunteers.',
    });
    mountWorkspace({ sourceDocument: deck, documentJob: deckJob });
    await screen.findByText('machine page 1');
    expect(screen.getByText(/translation.slides.notesKept/)).toBeVisible();
    expect(screen.getAllByText('Thank the volunteers.')).toHaveLength(1);
    expect(screen.queryByText('translation.slides.hidden')).toBeNull();
  });

  it('says a .ppt was converted, and only then', async () => {
    const { unmount } = mountWorkspace({
      sourceDocument: deck,
      documentJob: deckJob,
    });
    await screen.findByText('machine page 1');
    expect(screen.queryByText('translation.slides.converted')).toBeNull();
    unmount();
    mountWorkspace({
      sourceDocument: { ...deck, name: 'old.ppt', url: '/api/file/old.ppt' },
      documentJob: { ...deckJob, sourceName: 'old.pptx' },
    });
    expect(
      await screen.findByText('translation.slides.converted'),
    ).toBeVisible();
  });

  it('keeps page wording and no notes for a PDF', async () => {
    mountWorkspace({ documentJob: readyJob });
    await screen.findByText('machine page 1');
    expect(screen.getByText('translation.pageLabel')).toBeVisible();
    expect(screen.queryByText('translation.slides.notes')).toBeNull();
  });
});
