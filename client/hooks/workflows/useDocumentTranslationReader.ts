'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import {
  DocumentJobPage,
  DocumentJobPages,
  fetchDocumentJobPages,
  fetchDocumentJobStatus,
  saveDocumentPageCorrection,
} from '@/client/services/workflows/documentTranslationJob';

import {
  correctionToSave,
  pendingPollInterval,
} from '@/lib/utils/shared/translation/documentMode';

import { TranslationDocumentJob } from '@/types/workflow';

/** Pages fetched per request; windows are aligned so they cache cleanly. */
export const READER_PAGE_WINDOW = 5;

/**
 * Status checks that may fail in a row before the hook stops asking and
 * reports the job as stalled, leaving the next check to the user.
 */
export const MAX_CONSECUTIVE_STATUS_FAILURES = 15;

/** How long typing must pause before a page correction is saved. */
export const CORRECTION_SAVE_DELAY_MS = 700;

/** First page of the aligned window that contains `page`. */
export function pageWindowStart(page: number): number {
  return Math.floor((page - 1) / READER_PAGE_WINDOW) * READER_PAGE_WINDOW + 1;
}

const pagesKey = (jobId: string, windowStart: number) =>
  ['document-translation-pages', jobId, windowStart] as const;

interface UseDocumentTranslationReaderOptions {
  /** The job the conversation refers to, if any. */
  job: TranslationDocumentJob | undefined;
  /** True while the workspace is in whole-document mode. */
  active: boolean;
  /** The translation pane's text (the page in view, when the reader holds it). */
  paneText: string | undefined;
  /** Merges fields into the stored job. */
  onJobChange: (patch: Partial<TranslationDocumentJob>) => void;
  /** Puts a page's translation in the translation pane. */
  onShowPage: (page: number, text: string) => void;
}

export interface DocumentTranslationReader {
  /**
   * The running job's status could not be read many times in a row, and
   * checking has stopped. The job itself may still be running.
   */
  stalled: boolean;
  /** Starts checking a stalled job again. */
  retryStatus: () => void;
  /** The page in view, once its text has loaded. */
  page: DocumentJobPage | undefined;
  /** True while the page in view is being fetched. */
  loadingPage: boolean;
  /** Why the page in view could not be read, if it could not. */
  pageError: string | null;
  /** Reads the page in view again after a failure. */
  retryPage: () => void;
  /** Pages that have a saved correction, ascending. */
  correctedPages: number[];
  /** False when page numbers may not line up between source and translation. */
  pagesAligned: boolean;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
}

/**
 * Drives the whole-document reader: follows a running job to completion,
 * loads the page in view, hands it to the translation pane, and saves what
 * the user changes there as that page's correction.
 *
 * Page text is fetched a small window at a time and cached in memory by
 * the query client; none of it is written to workflow state. A job is
 * followed for as long as the workspace is mounted, whatever the mode, so
 * switching to a text mode while it runs does not stall it.
 *
 * Corrections are saved after a pause in typing. A change still waiting
 * when the user turns the page, leaves the mode, or closes the workspace is
 * saved at that moment instead of being dropped.
 */
export function useDocumentTranslationReader({
  job,
  active,
  paneText,
  onJobChange,
  onShowPage,
}: UseDocumentTranslationReaderOptions): DocumentTranslationReader {
  const queryClient = useQueryClient();
  const jobId = job?.jobId;
  const submittedAt = job ? Date.parse(job.submittedAt) : Number.NaN;

  // Callers pass inline callbacks; the effects below must not re-run for a
  // new function identity alone.
  const callbacks = useRef({ onJobChange, onShowPage });
  useEffect(() => {
    callbacks.current = { onJobChange, onShowPage };
  });

  // --- Follow a running job -------------------------------------------
  const pollDelay = () =>
    pendingPollInterval(
      Date.now() - (Number.isFinite(submittedAt) ? submittedAt : Date.now()),
    );
  const statusQuery = useQuery({
    queryKey: ['document-translation-status', jobId],
    queryFn: ({ signal }) => fetchDocumentJobStatus(jobId as string, signal),
    enabled: !!jobId && job?.status === 'translating',
    // A failed check is transient: it is repeated on the polling schedule,
    // and only a full run of failures puts the query in its error state.
    retry: MAX_CONSECUTIVE_STATUS_FAILURES - 1,
    retryDelay: () => pollDelay(),
    gcTime: 0,
    // Once stalled, stop asking until the user asks again.
    refetchInterval: (query) =>
      query.state.status === 'error' ? false : pollDelay(),
  });
  const status = statusQuery.data;
  useEffect(() => {
    if (!status || job?.status !== 'translating') return;
    if (status.status === 'Succeeded') {
      callbacks.current.onJobChange({
        status: 'preparing',
        expiresAt: status.reference.expiresAt,
        translatedFilename: status.reference.translatedFilename,
      });
    } else if (status.status === 'Failed') {
      callbacks.current.onJobChange({ status: 'failed', error: status.error });
    } else if (status.status === 'NotFound') {
      callbacks.current.onJobChange({ status: 'failed', error: '' });
    }
  }, [status, job?.status]);

  // --- Load the page in view -------------------------------------------
  const readable =
    active && !!job && (job.status === 'preparing' || job.status === 'ready');
  const pageNumber = job?.page ?? 1;
  const windowStart = pageWindowStart(pageNumber);
  const pagesQuery = useQuery({
    queryKey: pagesKey(jobId ?? '', windowStart),
    queryFn: ({ signal }) =>
      fetchDocumentJobPages(
        jobId as string,
        windowStart,
        windowStart + READER_PAGE_WINDOW - 1,
        signal,
      ),
    enabled: readable,
    staleTime: Infinity,
    retry: 1,
  });
  const pages = readable ? pagesQuery.data : undefined;
  const page = pages?.pages.find((entry) => entry.page === pageNumber);

  useEffect(() => {
    if (!job || !pages) return;
    if (job.status !== 'ready' || job.pageCount !== pages.pageCount) {
      callbacks.current.onJobChange({
        status: 'ready',
        pageCount: pages.pageCount,
      });
    }
  }, [job, pages]);

  const viewPage = job?.viewPage;
  useEffect(() => {
    if (!page || viewPage === page.page) return;
    callbacks.current.onShowPage(
      page.page,
      page.correction?.text ?? page.translation,
    );
  }, [page, viewPage]);

  // --- Save what the user changes ---------------------------------------
  const saveMutation = useMutation({
    mutationFn: (change: {
      jobId: string;
      page: number;
      text: string | null;
    }) => saveDocumentPageCorrection(change.jobId, change.page, change.text),
    onSuccess: (correctedPages, change) => {
      // Keep the cached page in step, so coming back to it shows the saved
      // text; every cached window learns the new list of corrected pages.
      queryClient.setQueriesData<DocumentJobPages>(
        { queryKey: ['document-translation-pages', change.jobId] },
        (cached) =>
          cached && {
            ...cached,
            correctedPages,
            pages: cached.pages.map((entry) => {
              if (entry.page !== change.page) return entry;
              const { correction: _previous, ...rest } = entry;
              return change.text === null
                ? rest
                : {
                    ...rest,
                    correction: {
                      text: change.text,
                      updatedAt: new Date().toISOString(),
                    },
                  };
            }),
          },
      );
    },
  });
  const { mutate: saveCorrection } = saveMutation;

  const pendingSave = useRef<{
    jobId: string;
    page: number;
    text: string | null;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const flushPendingSave = useRef(() => {});
  useEffect(() => {
    flushPendingSave.current = () => {
      const pending = pendingSave.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingSave.current = null;
      saveCorrection({
        jobId: pending.jobId,
        page: pending.page,
        text: pending.text,
      });
    };
  }, [saveCorrection]);

  const editable =
    readable && !!jobId && !!page && viewPage === page.page ? page : undefined;
  const savedText = editable?.correction?.text ?? null;
  const machineTranslation = editable?.translation;
  const editablePage = editable?.page;
  useEffect(() => {
    const pending = pendingSave.current;
    const sameTarget =
      !!pending && pending.jobId === jobId && pending.page === editablePage;
    // A change waiting for another page (or job) is saved now, not dropped.
    if (pending && !sameTarget) flushPendingSave.current();
    if (
      !jobId ||
      editablePage === undefined ||
      machineTranslation === undefined
    ) {
      return;
    }

    const wanted = correctionToSave(paneText ?? '', machineTranslation);
    if (pendingSave.current) {
      clearTimeout(pendingSave.current.timer);
      pendingSave.current = null;
    }
    if (wanted === savedText) return;
    pendingSave.current = {
      jobId,
      page: editablePage,
      text: wanted,
      timer: setTimeout(
        () => flushPendingSave.current(),
        CORRECTION_SAVE_DELAY_MS,
      ),
    };
  }, [jobId, editablePage, machineTranslation, savedText, paneText]);
  // Closing the workspace must not lose a change that is still waiting.
  useEffect(() => () => flushPendingSave.current(), []);

  return {
    stalled: job?.status === 'translating' && statusQuery.isError,
    retryStatus: () => void statusQuery.refetch(),
    page,
    loadingPage: readable && !page && pagesQuery.isFetching,
    pageError:
      readable && !page && pagesQuery.isError
        ? pagesQuery.error instanceof Error
          ? pagesQuery.error.message
          : String(pagesQuery.error)
        : null,
    retryPage: () => void pagesQuery.refetch(),
    correctedPages: pages?.correctedPages ?? [],
    pagesAligned: pages?.pagesAligned ?? true,
    saveState: saveMutation.isPending
      ? 'saving'
      : saveMutation.isError
        ? 'error'
        : saveMutation.isSuccess
          ? 'saved'
          : 'idle',
  };
}
