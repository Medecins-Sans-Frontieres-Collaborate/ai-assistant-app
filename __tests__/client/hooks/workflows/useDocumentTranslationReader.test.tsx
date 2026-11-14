import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';

import {
  CORRECTION_SAVE_DELAY_MS,
  READER_PAGE_WINDOW,
  pageWindowStart,
  useDocumentTranslationReader,
} from '@/client/hooks/workflows/useDocumentTranslationReader';

import {
  DocumentJobPages,
  fetchDocumentJobPages,
  fetchDocumentJobStatus,
  saveDocumentPageCorrection,
} from '@/client/services/workflows/documentTranslationJob';

import { TranslationDocumentJob } from '@/types/workflow';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/workflows/documentTranslationJob', () => ({
  fetchDocumentJobPages: vi.fn(),
  fetchDocumentJobStatus: vi.fn(),
  saveDocumentPageCorrection: vi.fn(),
}));

const PAGE_COUNT = 12;

function windowOf(from: number, corrections: Record<number, string> = {}) {
  const to = Math.min(from + READER_PAGE_WINDOW - 1, PAGE_COUNT);
  const pages: DocumentJobPages['pages'] = [];
  for (let page = from; page <= to; page += 1) {
    pages.push({
      page,
      source: `source ${page}`,
      translation: `machine ${page}`,
      ...(corrections[page] !== undefined && {
        correction: { text: corrections[page], updatedAt: 'then' },
      }),
    });
  }
  return {
    pageCount: PAGE_COUNT,
    pagesAligned: true,
    from,
    to,
    pages,
    correctedPages: Object.keys(corrections).map(Number),
  };
}

const baseJob: TranslationDocumentJob = {
  jobId: 'job-1',
  status: 'ready',
  submittedAt: new Date().toISOString(),
  sourceName: 'manual.pdf',
  translatedFilename: 'manual_es.pdf',
  fileExtension: 'pdf',
  targetLanguage: 'es',
  pageCount: PAGE_COUNT,
  page: 1,
};

/**
 * Hosts the hook the way the workspace does: the job and pane text live in
 * the caller, and the hook's callbacks patch them.
 */
function mountReader(initial: {
  job: TranslationDocumentJob;
  active?: boolean;
  paneText?: string;
}) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const host = {
    job: initial.job as TranslationDocumentJob | undefined,
    active: initial.active ?? true,
    paneText: initial.paneText as string | undefined,
  };
  const view = renderHook(
    () =>
      useDocumentTranslationReader({
        job: host.job,
        active: host.active,
        paneText: host.paneText,
        onJobChange: (patch) => {
          if (host.job) host.job = { ...host.job, ...patch };
        },
        onShowPage: (page, text) => {
          if (host.job) host.job = { ...host.job, page, viewPage: page };
          host.paneText = text;
        },
      }),
    { wrapper },
  );
  const settle = async () => {
    // Callbacks mutate the host; re-render until the hook has seen them.
    for (let pass = 0; pass < 4; pass += 1) {
      await act(async () => {
        await Promise.resolve();
      });
      view.rerender();
    }
  };
  return { host, view, settle };
}

beforeEach(() => {
  vi.mocked(fetchDocumentJobPages).mockImplementation(async (_job, from) =>
    windowOf(from),
  );
  vi.mocked(saveDocumentPageCorrection).mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('pageWindowStart', () => {
  it('aligns pages to windows on both sides of each boundary', () => {
    expect(pageWindowStart(1)).toBe(1);
    expect(pageWindowStart(READER_PAGE_WINDOW)).toBe(1);
    expect(pageWindowStart(READER_PAGE_WINDOW + 1)).toBe(
      READER_PAGE_WINDOW + 1,
    );
    expect(pageWindowStart(2 * READER_PAGE_WINDOW)).toBe(
      READER_PAGE_WINDOW + 1,
    );
  });
});

describe('following a running job', () => {
  it('moves to preparing when the job succeeds, then to ready with pages', async () => {
    vi.mocked(fetchDocumentJobStatus).mockResolvedValue({
      status: 'Succeeded',
      reference: {
        expiresAt: '2026-11-21T00:00:00.000Z',
        translatedFilename: 'final_es.pdf',
      } as never,
    });
    const { host, settle } = mountReader({
      job: { ...baseJob, status: 'translating', pageCount: undefined },
    });
    await waitFor(async () => {
      await settle();
      expect(host.job?.status).toBe('ready');
    });
    expect(host.job).toMatchObject({
      expiresAt: '2026-11-21T00:00:00.000Z',
      translatedFilename: 'final_es.pdf',
      pageCount: PAGE_COUNT,
      viewPage: 1,
    });
    expect(host.paneText).toBe('machine 1');
  });

  it('records a failure with its message', async () => {
    vi.mocked(fetchDocumentJobStatus).mockResolvedValue({
      status: 'Failed',
      error: 'bad pdf',
    });
    const { host, settle } = mountReader({
      job: { ...baseJob, status: 'translating' },
    });
    await waitFor(async () => {
      await settle();
      expect(host.job).toMatchObject({ status: 'failed', error: 'bad pdf' });
    });
    expect(fetchDocumentJobPages).not.toHaveBeenCalled();
  });

  it('fails without a message when the job is gone', async () => {
    vi.mocked(fetchDocumentJobStatus).mockResolvedValue({ status: 'NotFound' });
    const { host, settle } = mountReader({
      job: { ...baseJob, status: 'translating' },
    });
    await waitFor(async () => {
      await settle();
      expect(host.job).toMatchObject({ status: 'failed', error: '' });
    });
  });

  it('keeps following while another mode is active, but reads no pages', async () => {
    vi.mocked(fetchDocumentJobStatus).mockResolvedValue({
      status: 'Succeeded',
      reference: { expiresAt: 'x', translatedFilename: 'y' } as never,
    });
    const { host, settle } = mountReader({
      job: { ...baseJob, status: 'translating' },
      active: false,
    });
    await waitFor(async () => {
      await settle();
      expect(host.job?.status).toBe('preparing');
    });
    expect(fetchDocumentJobPages).not.toHaveBeenCalled();
    expect(host.paneText).toBeUndefined();
  });
});

describe('reading pages', () => {
  it('shows the correction instead of the machine translation', async () => {
    vi.mocked(fetchDocumentJobPages).mockImplementation(async (_job, from) =>
      windowOf(from, { 2: 'fixed 2' }),
    );
    const { host, view, settle } = mountReader({
      job: { ...baseJob, page: 2 },
    });
    await waitFor(async () => {
      await settle();
      expect(host.paneText).toBe('fixed 2');
    });
    expect(view.result.current.correctedPages).toEqual([2]);
    expect(view.result.current.page?.source).toBe('source 2');
  });

  it('fetches a new window only when the page leaves the cached one', async () => {
    const { host, settle } = mountReader({ job: baseJob });
    await waitFor(async () => {
      await settle();
      expect(host.paneText).toBe('machine 1');
    });
    host.job = { ...host.job!, page: READER_PAGE_WINDOW };
    await waitFor(async () => {
      await settle();
      expect(host.paneText).toBe(`machine ${READER_PAGE_WINDOW}`);
    });
    expect(fetchDocumentJobPages).toHaveBeenCalledTimes(1);

    host.job = { ...host.job!, page: READER_PAGE_WINDOW + 1 };
    await waitFor(async () => {
      await settle();
      expect(host.paneText).toBe(`machine ${READER_PAGE_WINDOW + 1}`);
    });
    expect(fetchDocumentJobPages).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchDocumentJobPages).mock.calls[1].slice(1, 3)).toEqual([
      READER_PAGE_WINDOW + 1,
      2 * READER_PAGE_WINDOW,
    ]);
  });

  it('reports a page that cannot be read', async () => {
    vi.mocked(fetchDocumentJobPages).mockRejectedValue(new Error('expired'));
    const { view, settle } = mountReader({ job: baseJob });
    await waitFor(
      async () => {
        await settle();
        expect(view.result.current.pageError).toBe('expired');
      },
      { timeout: 4000 },
    );
  });
});

describe('saving corrections', () => {
  async function readerOnPageOne() {
    const mounted = mountReader({ job: baseJob });
    await waitFor(async () => {
      await mounted.settle();
      expect(mounted.host.paneText).toBe('machine 1');
    });
    vi.useFakeTimers();
    return mounted;
  }
  const edit = async (
    mounted: Awaited<ReturnType<typeof readerOnPageOne>>,
    text: string,
  ) => {
    mounted.host.paneText = text;
    await act(async () => {
      mounted.view.rerender();
    });
  };

  it('does not save a page that was only shown', async () => {
    await readerOnPageOne();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CORRECTION_SAVE_DELAY_MS * 3);
    });
    expect(saveDocumentPageCorrection).not.toHaveBeenCalled();
  });

  it('saves once after typing pauses, not per keystroke', async () => {
    const mounted = await readerOnPageOne();
    await edit(mounted, 'machine 1 a');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CORRECTION_SAVE_DELAY_MS - 1);
    });
    await edit(mounted, 'machine 1 ab');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CORRECTION_SAVE_DELAY_MS - 1);
    });
    expect(saveDocumentPageCorrection).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(saveDocumentPageCorrection).toHaveBeenCalledTimes(1);
    expect(saveDocumentPageCorrection).toHaveBeenCalledWith(
      'job-1',
      1,
      'machine 1 ab',
    );
  });

  it('cancels the save when the text returns to what is stored', async () => {
    const mounted = await readerOnPageOne();
    await edit(mounted, 'changed');
    await edit(mounted, 'machine 1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CORRECTION_SAVE_DELAY_MS * 2);
    });
    expect(saveDocumentPageCorrection).not.toHaveBeenCalled();
  });

  it('saves a waiting change at once when the page is turned', async () => {
    const mounted = await readerOnPageOne();
    await edit(mounted, 'changed 1');
    mounted.host.job = { ...mounted.host.job!, page: 2 };
    await act(async () => {
      mounted.view.rerender();
      await Promise.resolve();
    });
    expect(saveDocumentPageCorrection).toHaveBeenCalledWith(
      'job-1',
      1,
      'changed 1',
    );
  });

  it('saves a waiting change when the mode is left', async () => {
    const mounted = await readerOnPageOne();
    await edit(mounted, 'changed 1');
    mounted.host.active = false;
    mounted.host.paneText = 'text mode result';
    await act(async () => {
      mounted.view.rerender();
    });
    expect(saveDocumentPageCorrection).toHaveBeenCalledTimes(1);
    expect(saveDocumentPageCorrection).toHaveBeenCalledWith(
      'job-1',
      1,
      'changed 1',
    );
  });

  it('saves a waiting change on unmount', async () => {
    const mounted = await readerOnPageOne();
    await edit(mounted, 'changed 1');
    mounted.view.unmount();
    // The mutation starts on the next microtask, after the unmount.
    await act(async () => {
      await Promise.resolve();
    });
    expect(saveDocumentPageCorrection).toHaveBeenCalledWith(
      'job-1',
      1,
      'changed 1',
    );
  });

  it('removes the correction when the machine translation is restored', async () => {
    vi.mocked(fetchDocumentJobPages).mockImplementation(async (_job, from) =>
      windowOf(from, { 1: 'fixed 1' }),
    );
    const mounted = mountReader({ job: baseJob });
    await waitFor(async () => {
      await mounted.settle();
      expect(mounted.host.paneText).toBe('fixed 1');
    });
    vi.useFakeTimers();
    await edit(mounted, 'machine 1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CORRECTION_SAVE_DELAY_MS);
    });
    expect(saveDocumentPageCorrection).toHaveBeenCalledWith('job-1', 1, null);
  });

  it('remembers a saved correction when the page is revisited', async () => {
    vi.mocked(saveDocumentPageCorrection).mockResolvedValue([1]);
    const mounted = await readerOnPageOne();
    await edit(mounted, 'changed 1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CORRECTION_SAVE_DELAY_MS);
    });
    vi.useRealTimers();
    await waitFor(async () => {
      await mounted.settle();
      expect(mounted.view.result.current.correctedPages).toEqual([1]);
    });
    expect(mounted.view.result.current.page?.correction?.text).toBe(
      'changed 1',
    );
    expect(mounted.view.result.current.saveState).toBe('saved');
    // The stored text now equals the pane: nothing further is saved.
    expect(saveDocumentPageCorrection).toHaveBeenCalledTimes(1);
  });
});
