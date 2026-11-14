/**
 * Text-mode states of the Translation workspace: what a running
 * translation, a running assessment and an upload look like, and how the
 * analysis strip collapses, is dismissed, and comes back.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { TRANSLATION_ACTIVITY } from '@/lib/utils/shared/translation/runProgress';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useWorkflowRunStore } from '@/client/stores/workflowRunStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONVERSATION_ID = 'run-states';

type StreamOptions = {
  onEvent: (event: { type: string; data: unknown }) => void;
  onText: (fullText: string, delta: string) => void;
};
const runWorkflowStream = vi.fn<(options: StreamOptions) => Promise<void>>();
const assessTranslation = vi.fn();

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream }),
}));
vi.mock('@/client/services/workflows/translationAssessment', () => ({
  assessTranslation: (input: unknown) => assessTranslation(input),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('@/client/services/workflows/railMessages', () => ({
  appendWorkflowRailMessages: vi.fn(),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

const ANALYSIS = {
  register: 'clinical',
  trickyTerms: [{ term: 'PO', issue: 'abbreviation', suggestion: 'VO' }],
  ambiguities: [],
  notes: '',
};

/** Rejects like `fetch` does when its signal aborts, and never resolves. */
function pendingUntilAborted(signal?: AbortSignal | null): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')),
    );
  });
}

function seedConversation(overrides: Partial<TranslationWorkflowState> = {}) {
  const workflowState: TranslationWorkflowState = {
    kind: 'translation',
    sourceText: 'Give 1 tab once daily.',
    targetLanguage: { id: 'es', label: 'Spanish' },
    mode: 'agentic',
    rounds: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  useConversationStore.setState({
    conversations: [
      {
        id: CONVERSATION_ID,
        name: 'Run states',
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
    selectedConversationId: CONVERSATION_ID,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function renderWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TranslationWorkspace conversationId={CONVERSATION_ID} />
    </QueryClientProvider>,
  );
}

function setRunning(activityKey?: string, params?: Record<string, string>) {
  act(() =>
    useWorkflowRunStore.setState({
      runs: {
        [CONVERSATION_ID]: {
          isRunning: true,
          activityKey,
          activityParams: params,
        },
      },
    }),
  );
}

const activeStep = () =>
  screen
    .getAllByRole('listitem')
    .find((item) => item.getAttribute('aria-current') === 'step');
const stripHeader = () =>
  screen.getByRole('button', { name: /translation\.analysisTitle/ });

beforeEach(() => {
  vi.clearAllMocks();
  useWorkflowRunStore.setState({ runs: {} });
  useSettingsStore.setState({ translationAnalysisHidden: false });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ data: { guides: [] } }))),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('a running translation', () => {
  it('names the step a Reviewed run is on and follows it as it advances', () => {
    seedConversation();
    renderWorkspace();
    setRunning(TRANSLATION_ACTIVITY.analyzing);
    expect(activeStep()).toHaveTextContent('translation.stepAnalyzing');

    setRunning(TRANSLATION_ACTIVITY.reviewing, { round: '2', total: '3' });
    expect(activeStep()).toHaveTextContent('translation.stepReviewing');
    expect(
      screen.getByText('translation.runHintReviewingRound'),
    ).toBeInTheDocument();
    expect(screen.getByText(/translation\.runRound/)).toBeInTheDocument();
  });

  it('shows no steps for a Quick run, which has only one', () => {
    seedConversation({ mode: 'quick' });
    renderWorkspace();
    setRunning(TRANSLATION_ACTIVITY.translating);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('translation.translating')).toBeInTheDocument();
  });

  it('marks a Reviewed run text as a draft, and a Quick run text as not one', () => {
    seedConversation({ finalText: 'Dar 1 comprimido.' });
    const { unmount } = renderWorkspace();
    setRunning(TRANSLATION_ACTIVITY.reviewing, { round: '1', total: '3' });
    expect(screen.getByText('translation.draftLabel')).toBeInTheDocument();
    unmount();

    seedConversation({ mode: 'quick', finalText: 'Dar 1 comprimido.' });
    renderWorkspace();
    setRunning(TRANSLATION_ACTIVITY.translating);
    expect(
      screen.queryByText('translation.draftLabel'),
    ).not.toBeInTheDocument();
  });

  it('shows the streamed draft without the blank lines the stream pads it with', async () => {
    seedConversation();
    runWorkflowStream.mockImplementation(({ onText }) => {
      onText('\n\n\nDar 1 comprimido.\n\n', 'Dar 1 comprimido.');
      return new Promise<void>(() => {});
    });
    const { container } = renderWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translate' }),
    );
    setRunning(TRANSLATION_ACTIVITY.reviewing, { round: '1', total: '3' });
    await waitFor(() =>
      expect(container.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
        'Dar 1 comprimido.',
      ),
    );
  });

  it('offers a labelled Stop, says why the source is locked, and stops', () => {
    seedConversation();
    renderWorkspace();
    expect(
      screen.queryByText('translation.sourceLocked'),
    ).not.toBeInTheDocument();
    setRunning(TRANSLATION_ACTIVITY.translating);
    expect(screen.getByText('translation.sourceLocked')).toBeInTheDocument();

    const stop = screen.getByRole('button', { name: 'shell.stopGenerating' });
    expect(stop).toHaveTextContent('translation.stop');
    fireEvent.click(stop);
    expect(useWorkflowRunStore.getState().runs[CONVERSATION_ID].isRunning).toBe(
      false,
    );
  });
});

describe('the analysis strip', () => {
  it('starts as its header and expands on request', () => {
    seedConversation({ analysis: ANALYSIS });
    renderWorkspace();
    expect(stripHeader()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('PO')).not.toBeInTheDocument();
    fireEvent.click(stripHeader());
    expect(screen.getByText('PO')).toBeInTheDocument();
  });

  it('collapses again when a run completes', async () => {
    seedConversation({ analysis: ANALYSIS });
    runWorkflowStream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'analysis', data: ANALYSIS });
      onEvent({ type: 'complete', data: { finalText: 'Dar 1 comprimido.' } });
    });
    renderWorkspace();
    fireEvent.click(stripHeader());
    expect(stripHeader()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(
      screen.getByRole('button', { name: 'translation.translate' }),
    );
    await waitFor(() =>
      expect(stripHeader()).toHaveAttribute('aria-expanded', 'false'),
    );
  });

  it('is dismissed as a preference and comes back, expanded, from its pill', () => {
    seedConversation({ analysis: ANALYSIS });
    renderWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.analysisDismiss' }),
    );
    expect(useSettingsStore.getState().translationAnalysisHidden).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'translation.analysisDismiss' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('translation.analysisShow'));
    expect(useSettingsStore.getState().translationAnalysisHidden).toBe(false);
    expect(stripHeader()).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers no pill when a hidden strip would have nothing to show', () => {
    useSettingsStore.setState({ translationAnalysisHidden: true });
    seedConversation();
    renderWorkspace();
    expect(
      screen.queryByTitle('translation.analysisShow'),
    ).not.toBeInTheDocument();
  });
});

describe('a running assessment', () => {
  it('lists the criteria being checked and can be stopped without an error', async () => {
    seedConversation({ finalText: 'Dar 1 comprimido.' });
    assessTranslation.mockImplementation((input: { signal?: AbortSignal }) =>
      pendingUntilAborted(input.signal),
    );
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'translation.assess' }));

    const progress = await screen.findByText('translation.assessingCriteria');
    const column = progress.closest('[role="status"]') as HTMLElement;
    expect(
      within(column).getByText('translation.criteria.accuracy.label'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'translation.stop' }));
    await waitFor(() =>
      expect(
        screen.queryByText('translation.assessingCriteria'),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'translation.assess' }),
    ).toBeEnabled();
  });

  it('still reports an assessment that fails on its own', async () => {
    seedConversation({ finalText: 'Dar 1 comprimido.' });
    assessTranslation.mockRejectedValue(new Error('Assessment failed (500)'));
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'translation.assess' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Assessment failed (500)',
    );
  });
});

describe('an upload in progress', () => {
  function uploadPdf(container: HTMLElement) {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: {
        files: [
          new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' }),
        ],
      },
    });
  }

  it('shows the file and the step it is on, and cancels without an error', async () => {
    seedConversation({ mode: 'quick' });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/file/upload?'))
          return Promise.resolve(
            Response.json({ data: { uri: '/api/file/manual.pdf' } }),
          );
        if (url === '/api/file/process')
          return pendingUntilAborted(init?.signal);
        return Promise.resolve(Response.json({ data: { guides: [] } }));
      }),
    );
    const { container } = renderWorkspace();
    uploadPdf(container);

    await waitFor(() =>
      expect(activeStep()).toHaveTextContent('translation.uploadStepReading'),
    );
    expect(screen.getByText('manual.pdf')).toBeInTheDocument();
    expect(container.querySelector('textarea')).not.toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: 'translation.uploadCancel' }),
    );
    await waitFor(() =>
      expect(screen.queryByText('manual.pdf')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container.querySelector('textarea')).toBeVisible();
  });

  it('still reports an upload that fails on its own', async () => {
    seedConversation({ mode: 'quick' });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.startsWith('/api/file/upload?')
            ? Response.json(
                { error: 'Storage is unavailable' },
                { status: 503 },
              )
            : Response.json({ data: { guides: [] } }),
        ),
      ),
    );
    const { container } = renderWorkspace();
    uploadPdf(container);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Storage is unavailable',
    );
  });
});
