'use client';

import {
  IconDownload,
  IconLoader,
  IconPlayerStop,
  IconPlus,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import {
  JobFollower,
  isFollowAbort,
  useBackgroundJob,
} from '@/client/hooks/backgroundJobs/useBackgroundJob';

import {
  BrandReviewBusyError,
  BrandReviewGoneError,
  BrandReviewReading,
  listUsableBrandBooks,
  readBrandReview,
  removeBrandReview,
  startBrandReview,
  stopBrandReview,
} from '@/client/services/brand/brandReview';
import { fetchDocumentPdf } from '@/client/services/documents/documentPdf';

import {
  BrandFinding,
  BrandFindingSeverity,
  countBySeverity,
} from '@/lib/utils/shared/brand/brandFindings';
import {
  buildBrandReport,
  describeFinding,
} from '@/lib/utils/shared/brand/brandReport';

import { BrandReviewWorkflowState } from '@/types/workflow';

import {
  PageOverlay,
  PageOverlayTone,
} from '@/components/Documents/DocumentPage';
import {
  DocumentViewer,
  ViewerSource,
} from '@/components/Documents/DocumentViewer';

import { WorkflowWorkspaceProps } from '../registry';
import { BrandFindingsPanel } from './BrandFindingsPanel';
import { BrandReviewSetup, ReviewDocument } from './BrandReviewSetup';

import { useConversationStore } from '@/client/stores/conversationStore';

const TONE: Record<BrandFindingSeverity, PageOverlayTone> = {
  error: 'error',
  warning: 'warning',
  info: 'normal',
};

/**
 * Follows one review with useBackgroundJob. Built here from the imported
 * service functions (not inside the service module), so the module's own
 * calls cannot bypass what the functions are replaced with in tests.
 */
function reviewFollower(reviewId: string): JobFollower<BrandReviewReading> {
  return {
    read: (signal) => readBrandReview(reviewId, signal),
    stop: () => stopBrandReview(reviewId),
    isRunning: (reading) => reading.state.status === 'running',
  };
}

/** Presentation types, whose pages are called slides. */
const SLIDE_TYPES = new Set([
  'pptx',
  'pptm',
  'ppsx',
  'potx',
  'ppt',
  'pps',
  'pot',
  'odp',
]);

const quietButton =
  'inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800';

/**
 * The Brand review workflow (docs/DOCUMENT_PLATFORM.md, phase F): choose a
 * brand book and a document, run the review as a background job, and read
 * its findings over the pages and in a list, or download them as a report.
 * Leaving the page leaves the review running; coming back follows it again.
 */
export function BrandReviewWorkspace({
  conversationId,
}: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows.brandReview');
  const locale = useLocale();
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const ws =
    conversation?.workflowState?.kind === 'brand-review'
      ? (conversation.workflowState as BrandReviewWorkflowState)
      : null;

  const setWs = useCallback(
    (changes: Partial<Omit<BrandReviewWorkflowState, 'kind'>>) =>
      updateWorkflowState(conversationId, (prev) => ({
        ...(prev?.kind === 'brand-review'
          ? prev
          : { kind: 'brand-review' as const, modelReview: true }),
        ...changes,
        updatedAt: new Date().toISOString(),
      })),
    [conversationId, updateWorkflowState],
  );

  const booksQuery = useQuery({
    queryKey: ['brand-books'],
    queryFn: listUsableBrandBooks,
    staleTime: 60_000,
  });

  const jobs = useBackgroundJob<BrandReviewReading>();
  const [reading, setReading] = useState<BrandReviewReading | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{
    message: string | null;
    fallback: 'readFailed' | 'startFailed';
  } | null>(null);
  const [selected, setSelected] = useState<BrandFinding | null>(null);
  const [page, setPage] = useState(1);

  const reviewId = ws?.reviewId;
  // Follows a review until it ends. Errors are kept as data and worded at
  // render, so this never depends on `t` (whose identity may change).
  const follow = useCallback(
    async (id: string, signal: AbortSignal) => {
      const outcome = await jobs.follow(reviewFollower(id), {
        onReading: setReading,
        signal,
      });
      if (outcome.error instanceof BrandReviewGoneError) {
        setReading(null);
        setWs({ reviewId: undefined });
      } else if (outcome.error && !isFollowAbort(outcome.error)) {
        setError({
          message:
            outcome.error instanceof Error ? outcome.error.message : null,
          fallback: 'readFailed',
        });
      }
    },
    [jobs, setWs],
  );

  // Follow the conversation's review: a new one just started, or one
  // remembered from before a reload. A new id ends the old follow.
  useEffect(() => {
    if (!reviewId) return;
    const controller = new AbortController();
    void follow(reviewId, controller.signal);
    return () => controller.abort();
  }, [reviewId, follow]);

  const start = async () => {
    if (!ws?.bookId || !ws.document) return;
    setStarting(true);
    setError(null);
    try {
      const started = await startBrandReview({
        bookId: ws.bookId,
        file: ws.document.file,
        name: ws.document.name,
        modelReview: ws.modelReview,
      });
      setReading(started);
      setSelected(null);
      setPage(1);
      setWs({ reviewId: started.reviewId });
    } catch (err) {
      setError({
        message:
          err instanceof BrandReviewBusyError
            ? t('busy', { name: err.activeName ?? '' })
            : err instanceof Error
              ? err.message
              : null,
        fallback: 'startFailed',
      });
    } finally {
      setStarting(false);
    }
  };

  const newReview = async () => {
    const old = reviewId;
    setReading(null);
    setSelected(null);
    setWs({ reviewId: undefined });
    // The finished review is not kept once a new one is set up.
    if (old && reading?.state.status !== 'running') {
      await removeBrandReview(old).catch(() => undefined);
    }
  };

  const state = reading?.state ?? null;
  const findings = useMemo(() => state?.findings ?? [], [state]);
  const wsDocument = ws?.document;
  const document = useMemo<ReviewDocument | undefined>(
    () =>
      state
        ? {
            file: state.request.file,
            name: state.request.name,
            type: state.request.type,
          }
        : wsDocument,
    [state, wsDocument],
  );

  const translate = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      t(key as never, values as never),
    [t],
  );

  const sources = useMemo<[ViewerSource] | null>(() => {
    const upload =
      document &&
      /^\/api\/file\/([a-f0-9]{64}\.[a-z0-9]+)$/.exec(document.file);
    if (!document || !upload) return null;
    return [
      {
        key: document.file,
        label: document.name,
        load: () =>
          fetchDocumentPdf({
            kind: 'upload',
            id: upload[1],
            type: document.type,
          }),
      },
    ];
  }, [document]);

  const overlaysOf = useCallback(
    (pageNumber: number): PageOverlay[] =>
      findings
        .filter((finding) => finding.page === pageNumber && finding.box)
        .map((finding) => ({
          id: finding.id,
          box: finding.box!,
          tone: TONE[finding.severity],
          label: `${t(`rule.${finding.rule}`)}: ${describeFinding(finding, translate)}`,
        })),
    [findings, t, translate],
  );

  const errorsOn = useMemo(() => {
    const counts = new Map<number, number>();
    for (const finding of findings) {
      if (finding.page !== null)
        counts.set(finding.page, (counts.get(finding.page) ?? 0) + 1);
    }
    return counts;
  }, [findings]);

  const downloadReport = () => {
    if (!state) return;
    const html = buildBrandReport(
      {
        documentName: state.request.name,
        bookName: state.request.book.name,
        date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
          new Date(state.startedAt),
        ),
        locale,
        findings,
        pageCount: state.pageCount,
        skippedPages: state.skippedPages,
        partial: state.status !== 'done',
      },
      translate,
    );
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${state.request.name.replace(/\.[^.]+$/, '')} - ${t('report.fileSuffix')}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const errorText = error ? (error.message ?? t(error.fallback)) : null;

  if (!ws) return null;

  if (!reviewId || !state) {
    if (reviewId && !state && !error) {
      return (
        <p className="p-6 text-sm text-gray-500" role="status">
          {t('loading')}
        </p>
      );
    }
    return (
      <div className="h-full overflow-y-auto">
        <BrandReviewSetup
          books={booksQuery.data ?? []}
          booksLoading={booksQuery.isLoading}
          bookId={ws.bookId}
          onBook={(bookId) => setWs({ bookId })}
          document={ws.document}
          onDocument={(doc) => setWs({ document: doc })}
          modelReview={ws.modelReview}
          onModelReview={(modelReview) => setWs({ modelReview })}
          onStart={() => void start()}
          starting={starting}
          error={errorText ?? (booksQuery.error ? t('booksFailed') : null)}
        />
      </div>
    );
  }

  const running = state.status === 'running';
  const counts = countBySeverity(findings);
  const progress =
    state.phase === 'reviewing' && state.pageCount > 0
      ? t('progress.pages', {
          done: state.reviewedPages.length + state.skippedPages.length,
          total: state.pageCount,
        })
      : t(`progress.${state.phase}`);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {state.request.name}
          </h2>
          <p className="truncate text-xs text-gray-500 dark:text-gray-400">
            {t('against', { book: state.request.book.name })}
          </p>
        </div>
        <p
          className="text-xs text-gray-600 dark:text-gray-300"
          role="status"
          aria-live="polite"
        >
          {running ? (
            <span className="inline-flex items-center gap-1.5">
              <IconLoader size={14} className="animate-spin" aria-hidden />
              {progress}
            </span>
          ) : (
            t(`status.${state.status}`, {
              errors: counts.error,
              warnings: counts.warning,
            })
          )}
        </p>
        {running ? (
          <button
            type="button"
            className={quietButton}
            onClick={() => jobs.stop()}
          >
            <IconPlayerStop size={16} aria-hidden />
            {t('stop')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={quietButton}
              onClick={downloadReport}
            >
              <IconDownload size={16} aria-hidden />
              {t('download')}
            </button>
            <button
              type="button"
              className={quietButton}
              onClick={() => void newReview()}
            >
              <IconPlus size={16} aria-hidden />
              {t('newReview')}
            </button>
          </>
        )}
      </header>
      {state.status === 'failed' && (
        <p
          className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
          role="alert"
        >
          {state.error ?? t('failed')}
        </p>
      )}
      {error && (
        <p
          className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
          role="alert"
        >
          {errorText}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {sources && (
          <DocumentViewer
            sources={sources}
            unit={SLIDE_TYPES.has(state.request.type) ? 'slide' : 'page'}
            overlaysOf={overlaysOf}
            selectedOverlayId={selected?.id ?? null}
            onSelectOverlay={(id) =>
              setSelected(findings.find((finding) => finding.id === id) ?? null)
            }
            page={page}
            onPageChange={setPage}
            pageBadge={(pageNumber) =>
              errorsOn.get(pageNumber) ? (
                <span className="rounded-full bg-gray-900/80 px-1.5 text-[11px] font-medium text-white">
                  {errorsOn.get(pageNumber)}
                </span>
              ) : null
            }
            aside={
              <BrandFindingsPanel
                findings={findings}
                selectedId={selected?.id ?? null}
                onSelect={(finding) => {
                  setSelected(finding);
                  if (finding.page !== null) setPage(finding.page);
                }}
              />
            }
          />
        )}
      </div>
    </div>
  );
}
