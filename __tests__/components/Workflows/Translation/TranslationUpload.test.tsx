import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import messages from '@/messages/en.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream: vi.fn() }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    const template =
      key === 'document.referenceEmpty'
        ? messages.workflows.document.referenceEmpty
        : key === 'translation.tooLong'
          ? messages.workflows.translation.tooLong
          : key;
    return template.replace(/\{(\w+)\}/g, (_, name) => values?.[name] ?? name);
  },
}));

const ORIGINAL = 'Keep this existing source.';
let processingResponse: () => Response | Promise<Response>;
let uploadResponse: () => Response;
const fetchMock = vi.fn();

function sourceState(): TranslationWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as TranslationWorkflowState;
}

function uploadPdf() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TranslationWorkspace conversationId="pdf-audit" />
    </QueryClientProvider>,
  );
  const input =
    result.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['%PDF-1.4'], 'source.pdf', {
    type: 'application/pdf',
  });
  fireEvent.change(input, { target: { files: [file] } });
  return { input, file };
}

beforeEach(() => {
  vi.clearAllMocks();
  const workflowState: TranslationWorkflowState = {
    kind: 'translation',
    sourceText: ORIGINAL,
    targetLanguage: { id: 'fr', label: 'French' },
    mode: 'quick',
    rounds: [],
    updatedAt: new Date().toISOString(),
  };
  useConversationStore.setState({
    conversations: [
      {
        id: 'pdf-audit',
        name: 'Original',
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
        workflowState,
      } as unknown as Conversation,
    ],
    selectedConversationId: 'pdf-audit',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
  uploadResponse = () =>
    Response.json({ data: { uri: '/api/file/source.pdf' } });
  processingResponse = () =>
    Response.json({ results: [{ content: 'New extracted source.' }] });
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/file/upload?'))
      return Promise.resolve(uploadResponse());
    if (url === '/api/file/process')
      return Promise.resolve(processingResponse());
    return Promise.resolve(Response.json({ data: { guides: [] } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('Translation PDF uploads — actual upload helper and workspace', () => {
  it.each(['', ' \n\t'])(
    'shows the filename message for empty successful extraction: %j',
    async (content) => {
      processingResponse = () => Response.json({ results: [{ content }] });
      const { input } = uploadPdf();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'No text could be extracted from source.pdf',
      );
      expect(sourceState().sourceText).toBe(ORIGINAL);
      expect(nameWorkflowConversation).not.toHaveBeenCalled();
      expect(input.value).toBe('');
      expect(
        screen.getByRole('button', { name: 'translation.uploadDocument' }),
      ).toBeEnabled();
    },
  );

  it('localizes the typed no-text failure instead of showing a server error', async () => {
    processingResponse = () =>
      Response.json(
        {
          error:
            'The PDF contains no extractable text (scanned or image-only?)',
          code: 'NO_EXTRACTABLE_TEXT',
        },
        { status: 422 },
      );
    uploadPdf();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No text could be extracted from source.pdf',
    );
    expect(sourceState().sourceText).toBe(ORIGINAL);
    expect(nameWorkflowConversation).not.toHaveBeenCalled();
  });

  it('resets the file input and clears the error when retrying the same file', async () => {
    processingResponse = () => Response.json({ results: [{ content: '' }] });
    const { input, file } = uploadPdf();
    // jsdom does not populate a file input's fakepath when firing change.
    Object.defineProperty(input, 'value', {
      configurable: true,
      writable: true,
      value: 'C:\\fakepath\\source.pdf',
    });
    await screen.findByRole('alert');
    expect(input.value).toBe('');
    processingResponse = () =>
      Response.json({ results: [{ content: 'Recovered source.' }] });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(sourceState().sourceText).toBe('Recovered source.'),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'translation.uploadDocument' }),
    ).toBeEnabled();
  });

  it.each([
    [
      'PROCESSING_FAILED',
      'Failed to extract text from PDF (password required)',
      500,
    ],
    ['PROCESSING_FAILED', 'Storage unavailable', 503],
  ])('preserves technical failures (%s, %s)', async (code, error, status) => {
    processingResponse = () => Response.json({ code, error }, { status });
    uploadPdf();
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(sourceState().sourceText).toBe(ORIGINAL);
    expect(nameWorkflowConversation).not.toHaveBeenCalled();
  });

  it('distinguishes a malformed processing response from an empty PDF', async () => {
    processingResponse = () => Response.json({ results: [] });
    uploadPdf();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'server response is missing the result',
    );
    expect(sourceState().sourceText).toBe(ORIGINAL);
  });

  it('stops after an upload failure', async () => {
    uploadResponse = () =>
      Response.json({ error: 'File too large' }, { status: 413 });
    uploadPdf();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'File too large',
    );
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/file/process'),
    ).toBe(false);
    expect(sourceState().sourceText).toBe(ORIGINAL);
  });

  it('accepts the source at the limit and names the workflow', async () => {
    const content = 'x'.repeat(60_000);
    processingResponse = () => Response.json({ results: [{ content }] });
    uploadPdf();
    await waitFor(() => expect(sourceState().sourceText).toBe(content));
    expect(nameWorkflowConversation).toHaveBeenCalledWith('pdf-audit', {
      label: 'source.pdf',
      sample: content,
      workflow: 'Translation',
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects oversized source instead of silently losing the end of the PDF', async () => {
    processingResponse = () =>
      Response.json({ results: [{ content: 'x'.repeat(60_001) }] });
    uploadPdf();
    expect(await screen.findByRole('alert')).toHaveTextContent('60000');
    expect(sourceState().sourceText).toBe(ORIGINAL);
    expect(nameWorkflowConversation).not.toHaveBeenCalled();
  });

  it('prevents source edits and translation while extraction is pending, then recovers', async () => {
    let complete!: (response: Response) => void;
    processingResponse = () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      });
    uploadPdf();
    await waitFor(() => expect(complete).toBeDefined());
    expect(
      screen.getByPlaceholderText('translation.sourcePlaceholder'),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'translation.translate' }),
    ).toBeDisabled();
    complete(Response.json({ results: [{ content: 'New source.' }] }));
    await waitFor(() => expect(sourceState().sourceText).toBe('New source.'));
    expect(
      screen.getByPlaceholderText('translation.sourcePlaceholder'),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'translation.translate' }),
    ).toBeEnabled();
  });
});
