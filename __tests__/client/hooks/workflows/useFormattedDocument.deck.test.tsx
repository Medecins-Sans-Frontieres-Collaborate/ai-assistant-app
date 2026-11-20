import { act, renderHook, waitFor } from '@testing-library/react';

import {
  DECK_POLL_MS,
  progressOfDeckJob,
  useFormattedDocument,
} from '@/client/hooks/workflows/useFormattedDocument';

import {
  DeckRunBusyError,
  readDeckJob,
  startDeckJob,
  stopDeckJob,
} from '@/client/services/workflows/nativeDeckJob';
import {
  renderNativePdf,
  runNativePdf,
} from '@/client/services/workflows/nativePdfTranslation';

import type {
  FormattedDocumentRun,
  FormattedPendingJob,
} from '@/lib/utils/shared/translation/formattedDocument';
import type {
  NativeDeckJobPiece,
  NativeDeckJobView,
} from '@/lib/utils/shared/translation/nativeDeckJob';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The run hook on a presentation: it starts a background job instead of
 * streaming requests, follows it (queue place and estimate included), puts
 * its batches into the run when it ends, follows it again after a reload,
 * and stops it on the server.
 */

vi.mock('@/client/services/workflows/nativeDeckJob', async (original) => ({
  ...(await original<object>()),
  startDeckJob: vi.fn(),
  readDeckJob: vi.fn(),
  stopDeckJob: vi.fn(),
  recordDeckJobUsage: vi.fn(),
}));
vi.mock('@/client/services/workflows/nativePdfTranslation', () => ({
  runNativePdf: vi.fn(),
  renderNativePdf: vi.fn(),
  reviseNativePdfUnit: vi.fn(),
}));
vi.mock('@/client/services/workflows/nativeRunStorage', async (original) => ({
  ...(await original<object>()),
  newRunAccess: vi.fn((backend: string) =>
    Promise.resolve({ runId: 'run-1', backend }),
  ),
}));

const ACCESS = { runId: 'run-1', backend: 'app' as const };

function piece(pages: number[]): NativeDeckJobPiece {
  return {
    steps: [],
    pageCount: 5,
    pages: pages.map((page) => ({
      page,
      width: 720,
      height: 540,
      units: 1,
      textChars: 5,
      scanned: false,
    })),
    units: [],
    issues: [],
    uncheckedPages: [],
    fonts: { sans: 'Calibri', serif: 'Cambria' },
    refitRounds: 0,
    pageImages: [],
    pdfUrl: `/pdf-${pages.join('-')}`,
    documentUrl: `/deck-${pages.join('-')}`,
    format: 'pptx',
    sourceId: 'a.pptx',
    unitsId: `u-${pages.join('-')}`,
    usage: { totalTokens: 10 },
  } as unknown as NativeDeckJobPiece;
}

function view(overrides: Partial<NativeDeckJobView> = {}): NativeDeckJobView {
  return {
    jobId: 'j',
    runId: 'run-1',
    backend: 'app',
    status: 'running',
    pieces: [],
    startedAt: 0,
    heartbeatAt: 0,
    resumes: 0,
    sourceName: 'Deck.pptx',
    format: 'pptx',
    targetLanguage: 'French',
    parts: 1,
    pageCount: 2,
    translateNotes: false,
    ...overrides,
  };
}
const QUEUE = {
  running: 2,
  queued: { interactive: 0, translation: 3 },
  maxConcurrent: 2,
  averageRunMs: { interactive: null, translation: 90_000 },
};

function mount(pendingJob?: FormattedPendingJob) {
  const setRun = vi.fn();
  const setPendingJob = vi.fn();
  const hook = renderHook(
    (props: { pendingJob?: FormattedPendingJob }) =>
      useFormattedDocument({
        conversationId: 'c1',
        run: undefined,
        access: undefined,
        setRun,
        updateRun: vi.fn(),
        pendingJob: props.pendingJob,
        setPendingJob,
        glossaries: {},
      }),
    { initialProps: { pendingJob } },
  );
  return { ...hook, setRun, setPendingJob };
}

const request = {
  loadFile: async () => new File(['PK'], 'Deck.pptx'),
  sourceUrl: '/api/file/a.pptx',
  sourceName: 'Deck.pptx',
  targetLanguage: 'French',
  options: { pages: '', instructions: {}, refitRounds: 1 } as never,
  depth: 'quick' as const,
  translateNotes: false,
  pages: [1, 2],
  backend: 'app' as const,
};

beforeEach(() => {
  vi.mocked(startDeckJob).mockResolvedValue({
    job: view(),
    sourceId: 'a.pptx',
    sourceUrl: '/x',
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('progressOfDeckJob', () => {
  it('shows the queue place with an estimate from the queue', () => {
    const progress = progressOfDeckJob(
      {
        job: view({ current: { part: 1, steps: [], queueAhead: 3 } }),
        queue: QUEUE,
      },
      5,
    );
    // 3 ahead, 2 at a time: two rounds of 90 s.
    expect(progress.queue).toEqual({ ahead: 3, waitMs: 180_000 });
    expect(progress).toMatchObject({
      startedAt: 5,
      part: 1,
      parts: 1,
      pageCount: 2,
    });
  });

  it('shows no queue when nothing is ahead, and joining once every batch is done', () => {
    const progress = progressOfDeckJob(
      { job: view({ parts: 2, pieces: [piece([1]), piece([2])] }) },
      0,
    );
    expect(progress.queue).toBeUndefined();
    expect(progress.assembling).toBe(true);
  });
});

describe('a presentation run', () => {
  it('starts a job, follows it and keeps the server-joined result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(readDeckJob)
      .mockResolvedValueOnce({
        job: view({ current: { part: 1, steps: [], queueAhead: 2 } }),
        queue: QUEUE,
      })
      .mockResolvedValueOnce({
        job: view({ status: 'done', pieces: [piece([1, 2])] }),
      });
    const { result, setRun, setPendingJob } = mount();
    let finished!: Promise<void>;
    act(() => {
      finished = result.current.start(request);
    });
    await waitFor(() => expect(result.current.progress?.queue?.ahead).toBe(2));
    expect(runNativePdf).not.toHaveBeenCalled();
    expect(vi.mocked(startDeckJob).mock.calls[0][0]).toMatchObject({
      pages: '1-2',
      translateNotes: false,
      run: ACCESS,
    });
    expect(setPendingJob).toHaveBeenCalledWith(
      expect.objectContaining({ access: ACCESS, addsToBase: false }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DECK_POLL_MS);
      await finished;
    });
    const [stored, access] = setRun.mock.calls[0];
    expect(access).toEqual(ACCESS);
    expect(stored).toMatchObject({
      documentUrl: '/deck-1-2',
      format: 'pptx',
      translateNotes: false,
    });
    expect(setPendingJob).toHaveBeenLastCalledWith(undefined);
    expect(result.current.progress).toBeNull();
  });

  it('names the presentation already running instead of starting', async () => {
    vi.mocked(startDeckJob).mockRejectedValue(
      new DeckRunBusyError('Budget.pptx'),
    );
    const { result, setPendingJob } = mount();
    await act(() => result.current.start(request));
    expect(result.current.busyWith).toBe('Budget.pptx');
    expect(result.current.runError).toBeNull();
    expect(setPendingJob).not.toHaveBeenCalled();
  });

  it('reports a failed job, still keeping the batches that finished', async () => {
    vi.mocked(readDeckJob).mockResolvedValue({
      job: view({
        status: 'failed',
        error: 'The sandbox failed',
        pieces: [piece([1])],
      }),
    });
    const { result, setRun } = mount();
    await act(() => result.current.start(request));
    expect(result.current.runError).toBe('The sandbox failed');
    expect(setRun).toHaveBeenCalledTimes(1);
  });

  it('joins several batches itself when the server did not', async () => {
    vi.mocked(readDeckJob).mockResolvedValue({
      job: view({
        status: 'stopped',
        parts: 2,
        pieces: [piece([1]), piece([2])],
      }),
    });
    vi.mocked(renderNativePdf).mockResolvedValue({
      fits: [],
      issues: [],
      checkedPages: [],
      uncheckedPages: [],
      fonts: { sans: 'A', serif: 'B' },
      repaired: [],
      tooLong: [],
      pdfUrl: '/joined.pdf',
      documentUrl: '/joined.pptx',
      pageImages: [],
      unitsId: 'u-joined',
    } as never);
    const { result, setRun } = mount();
    await act(() => result.current.start(request));
    expect(vi.mocked(renderNativePdf).mock.calls[0][0].unitsIds).toEqual([
      'u-1',
      'u-2',
    ]);
    expect((setRun.mock.calls[0][0] as FormattedDocumentRun).documentUrl).toBe(
      '/joined.pptx',
    );
  });
});

describe('after a reload', () => {
  const pending: FormattedPendingJob = {
    access: ACCESS,
    sourceUrl: '/api/file/a.pptx',
    sourceName: 'Deck.pptx',
    targetLanguage: 'French',
    depth: 'quick',
    addsToBase: false,
    startedAt: 1,
  };

  it('follows the remembered job without starting another', async () => {
    vi.mocked(readDeckJob).mockResolvedValue({
      job: view({ status: 'done', pieces: [piece([1, 2])] }),
    });
    const { setRun, setPendingJob } = mount(pending);
    await waitFor(() => expect(setRun).toHaveBeenCalled());
    expect(startDeckJob).not.toHaveBeenCalled();
    expect(setPendingJob).toHaveBeenCalledWith(undefined);
  });

  it('leaves the job remembered when the page goes away mid-run', async () => {
    vi.mocked(readDeckJob).mockResolvedValue({ job: view() });
    const { result, unmount, setPendingJob, setRun } = mount(pending);
    await waitFor(() => expect(result.current.progress).not.toBeNull());
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(setPendingJob).not.toHaveBeenCalled();
    expect(setRun).not.toHaveBeenCalled();
  });

  it('asks the server to stop the job it follows', async () => {
    vi.mocked(readDeckJob).mockResolvedValue({ job: view() });
    vi.mocked(stopDeckJob).mockResolvedValue({
      job: view({ status: 'stopped' }),
    });
    const { result } = mount(pending);
    await waitFor(() => expect(result.current.progress).not.toBeNull());
    act(() => result.current.stop());
    expect(stopDeckJob).toHaveBeenCalledWith(ACCESS);
    // Still followed until the server says it has stopped.
    expect(result.current.progress).not.toBeNull();
  });
});
