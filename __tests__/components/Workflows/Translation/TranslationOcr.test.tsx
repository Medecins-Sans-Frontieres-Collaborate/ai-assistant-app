import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  MAX_OCR_PAGES,
  SPARSE_TEXT_CHARS_PER_PAGE,
} from '@/lib/utils/shared/file/ocr';

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
// Keys are rendered as-is with their values appended.
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

const ORIGINAL = 'Keep this existing source.';
const FILE_URL = '/api/file/scan.pdf';
const OCR_TEXT =
  '--- Page 1 ---\nTexto leído\n\n--- Page 2 ---\nSegunda página';
const fetchMock = vi.fn();
let processResponse: () => Response;
let ocrResponse: () => Response | Promise<Response>;

const noText = (ocrAvailable: boolean) => () =>
  Response.json(
    { error: 'no text', code: 'NO_EXTRACTABLE_TEXT', ocrAvailable },
    { status: 422 },
  );
const extracted = (content: string, ocrAvailable: boolean) => () =>
  Response.json({ results: [{ content }], ocrAvailable });

function state(): TranslationWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as TranslationWorkflowState;
}
const ocrCalls = () =>
  fetchMock.mock.calls.filter(([url]) => url === '/api/file/ocr');

function upload(name = 'scan.pdf') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TranslationWorkspace conversationId="ocr" />
    </QueryClientProvider>,
  );
  fireEvent.change(
    view.container.querySelector<HTMLInputElement>('input[type="file"]')!,
    {
      target: {
        files: [new File(['%PDF-1.4'], name, { type: 'application/pdf' })],
      },
    },
  );
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({
    conversations: [
      {
        id: 'ocr',
        name: 'OCR',
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
        workflowState: {
          kind: 'translation',
          sourceText: ORIGINAL,
          targetLanguage: { id: 'es', label: 'Spanish' },
          mode: 'quick',
          rounds: [],
          updatedAt: new Date().toISOString(),
        } satisfies TranslationWorkflowState,
      } as unknown as Conversation,
    ],
    selectedConversationId: 'ocr',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
  processResponse = noText(true);
  ocrResponse = () =>
    Response.json({ success: true, data: { content: OCR_TEXT, pageCount: 2 } });
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/file/upload?')) {
      return Promise.resolve(Response.json({ data: { uri: FILE_URL } }));
    }
    if (url === '/api/file/process') return Promise.resolve(processResponse());
    if (url === '/api/file/ocr') return Promise.resolve(ocrResponse());
    return Promise.resolve(Response.json({ data: { guides: [] } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('OCR offer for a PDF without text', () => {
  it('offers OCR instead of an error, and runs nothing until asked', async () => {
    upload();
    expect(
      await screen.findByText('translation.ocrReasonNoText scan.pdf'),
    ).toBeInTheDocument();
    expect(screen.getByText(/translation.ocrExplanation/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(ocrCalls()).toHaveLength(0);
    expect(state().sourceText).toBe(ORIGINAL);
  });

  it('offers only whole-document translation when OCR is not available', async () => {
    processResponse = noText(false);
    upload();
    expect(
      await screen.findByText('translation.ocrReasonNoText scan.pdf'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'translation.ocrRun' }),
    ).toBeNull();
    expect(screen.queryByText(/translation.ocrExplanation/)).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'translation.scannedUseWholeDocument',
      }),
    ).toBeInTheDocument();
  });

  it('does not offer OCR for a format it cannot read', async () => {
    upload('scan.docx');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'document.referenceEmpty scan.docx',
    );
    expect(screen.queryByText(/translation.ocrReasonNoText/)).toBeNull();
  });

  it('also offers OCR when extraction succeeds with nothing in it', async () => {
    processResponse = extracted(' \n', true);
    upload();
    expect(
      await screen.findByText('translation.ocrReasonNoText scan.pdf'),
    ).toBeInTheDocument();
  });

  it('reads the stored file and loads the text without page markers', async () => {
    upload();
    fireEvent.click(
      await screen.findByRole('button', { name: 'translation.ocrRun' }),
    );
    await waitFor(() =>
      expect(state().sourceText).toBe('Texto leído\n\nSegunda página'),
    );
    expect(JSON.parse(ocrCalls()[0][1].body)).toEqual({ url: FILE_URL });
    expect(state().sourceDocument).toMatchObject({
      url: FILE_URL,
      ocrApplied: true,
      ocrAvailable: true,
      fitsOneBatch: true,
    });
    expect(screen.queryByText(/translation.ocrReasonNoText/)).toBeNull();
    // Marked as OCR text, and OCR is not offered a second time.
    expect(screen.getByText('translation.ocrApplied')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'translation.ocrButton' }),
    ).toBeNull();
  });

  it('shows the OCR step while reading and can be cancelled', async () => {
    let aborted = false;
    ocrResponse = () => new Promise<Response>(() => {});
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/file/upload?')) {
        return Promise.resolve(Response.json({ data: { uri: FILE_URL } }));
      }
      if (url === '/api/file/process')
        return Promise.resolve(processResponse());
      if (url === '/api/file/ocr') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(Response.json({ data: { guides: [] } }));
    });
    upload();
    fireEvent.click(
      await screen.findByRole('button', { name: 'translation.ocrRun' }),
    );
    expect(
      await screen.findByText('translation.uploadStepOcr'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.uploadCancel' }),
    );
    // Back to the offer, with no error: cancelling is not a failure.
    expect(
      await screen.findByText('translation.ocrReasonNoText scan.pdf'),
    ).toBeInTheDocument();
    expect(aborted).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state().sourceText).toBe(ORIGINAL);
  });

  it.each([
    [429, 'LIMIT', 'translation.ocrLimitReached'],
    [413, 'OCR_TOO_MANY_PAGES', `translation.ocrTooManyPages ${MAX_OCR_PAGES}`],
    [503, 'OCR_NOT_CONFIGURED', 'translation.ocrUnavailable'],
    [422, 'NO_EXTRACTABLE_TEXT', 'translation.ocrNoText'],
    [502, 'OCR_FAILED', 'translation.ocrFailed'],
  ])(
    'explains a %s failure and keeps the offer open',
    async (status, code, message) => {
      ocrResponse = () => Response.json({ error: 'x', code }, { status });
      upload();
      fireEvent.click(
        await screen.findByRole('button', { name: 'translation.ocrRun' }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(
        screen.getByRole('button', { name: 'translation.retry' }),
      ).toBeInTheDocument();
      expect(state().sourceText).toBe(ORIGINAL);
    },
  );

  it('can be dismissed, leaving the source as it was', async () => {
    upload();
    fireEvent.click(
      await screen.findByRole('button', { name: 'translation.ocrDismiss' }),
    );
    expect(screen.queryByText(/translation.ocrReasonNoText/)).toBeNull();
    expect(screen.getByDisplayValue(ORIGINAL)).toBeVisible();
    expect(ocrCalls()).toHaveLength(0);
  });
});

describe('scanned PDF straight to whole-document translation', () => {
  const chooseWholeDocument = async () => {
    upload();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'translation.scannedUseWholeDocument',
      }),
    );
  };

  it('keeps the file, switches mode and is ready to translate', async () => {
    await chooseWholeDocument();
    expect(state()).toMatchObject({
      mode: 'document',
      sourceText: '',
      sourceDocument: {
        name: 'scan.pdf',
        url: FILE_URL,
        noText: true,
        ocrAvailable: true,
      },
    });
    expect(ocrCalls()).toHaveLength(0);
    expect(
      screen.getByText('translation.scannedSourceNote scan.pdf'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    ).toBeEnabled();
    // No page strip: there are no pages of text to choose between.
    expect(screen.queryByLabelText('translation.pagesLabel')).toBeNull();
  });

  it('submits the uploaded file itself', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/file/upload?')) {
        return Promise.resolve(Response.json({ data: { uri: FILE_URL } }));
      }
      if (url === '/api/file/process')
        return Promise.resolve(processResponse());
      if (url === '/api/document-translation/translate') {
        return Promise.resolve(
          Response.json(
            {
              success: true,
              data: {
                async: true,
                jobId: 'job-scan',
                originalFilename: 'scan.pdf',
                translatedFilename: 'scan_es.pdf',
                targetLanguage: 'es',
                fileExtension: 'pdf',
                submittedAt: new Date().toISOString(),
              },
            },
            { status: 202 },
          ),
        );
      }
      if (url.startsWith('/api/document-translation/status/')) {
        return Promise.resolve(
          Response.json({ success: true, data: { status: 'Running' } }),
        );
      }
      return Promise.resolve(Response.json({ data: { guides: [] } }));
    });
    await chooseWholeDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translateDocument' }),
    );
    await waitFor(() =>
      expect(state().documentJob).toMatchObject({ jobId: 'job-scan' }),
    );
    const submit = fetchMock.mock.calls.find(
      ([url]) => url === '/api/document-translation/translate',
    )!;
    expect(((submit[1].body as FormData).get('document') as File).name).toBe(
      'scan.pdf',
    );
    // Sent from memory: the stored copy is not downloaded again.
    expect(fetchMock.mock.calls.some(([url]) => url === FILE_URL)).toBe(false);
  });

  it('still lets the user read it with OCR afterwards', async () => {
    await chooseWholeDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.ocrButton' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'translation.ocrRun' }));
    await waitFor(() =>
      expect(state().sourceText).toBe('Texto leído\n\nSegunda página'),
    );
    expect(state().sourceDocument).toMatchObject({ ocrApplied: true });
    expect(state().sourceDocument?.noText).toBeUndefined();
  });

  it('lets go of the document when the user types their own source', async () => {
    await chooseWholeDocument();
    fireEvent.change(
      screen.getByPlaceholderText('translation.sourcePlaceholder'),
      {
        target: { value: 'My own text' },
      },
    );
    expect(state().sourceText).toBe('My own text');
    expect(state().sourceDocument).toBeUndefined();
  });

  it('is not offered for a file that cannot be translated whole', async () => {
    upload('scan.docx');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'document.referenceEmpty scan.docx',
    );
    expect(
      screen.queryByRole('button', {
        name: 'translation.scannedUseWholeDocument',
      }),
    ).toBeNull();
  });
});

describe('OCR for a PDF that has text', () => {
  const paged = (charsPerPage: number) =>
    `--- Page 1 ---\n${'a'.repeat(charsPerPage)}\n\n--- Page 2 ---\n${'b'.repeat(charsPerPage)}`;

  it('suggests OCR when the text is sparse, on the threshold side that needs it', async () => {
    processResponse = extracted(paged(SPARSE_TEXT_CHARS_PER_PAGE - 1), true);
    upload();
    expect(
      await screen.findByText('translation.ocrSparseHint'),
    ).toBeInTheDocument();
  });

  it('does not suggest it for text at the threshold', async () => {
    processResponse = extracted(paged(SPARSE_TEXT_CHARS_PER_PAGE), true);
    upload();
    await waitFor(() => expect(state().sourceDocument).toBeDefined());
    expect(screen.queryByText('translation.ocrSparseHint')).toBeNull();
  });

  it('never suggests it when OCR is unavailable', async () => {
    processResponse = extracted(paged(3), false);
    upload();
    await waitFor(() => expect(state().sourceDocument).toBeDefined());
    expect(screen.queryByText('translation.ocrSparseHint')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'translation.ocrButton' }),
    ).toBeNull();
  });

  it('lets the user ask for OCR, confirming the cost first', async () => {
    processResponse = extracted(paged(2000), true);
    upload();
    fireEvent.click(
      await screen.findByRole('button', { name: 'translation.ocrButton' }),
    );
    expect(
      screen.getByText('translation.ocrReasonManual scan.pdf'),
    ).toBeInTheDocument();
    expect(ocrCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'translation.ocrRun' }));
    await waitFor(() =>
      expect(state().sourceText).toBe('Texto leído\n\nSegunda página'),
    );
    expect(state().sourceDocument?.ocrApplied).toBe(true);
  });
});
