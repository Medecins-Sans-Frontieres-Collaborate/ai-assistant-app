'use client';

import {
  IconArrowLeft,
  IconDownload,
  IconLoader,
  IconPencil,
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
  listUsableBrandBooks,
  readBrandReview,
} from '@/client/services/brand/brandReview';
import {
  DeckBuildReading,
  DeckBuilderBusyError,
  DeckOutlineReading,
  DeckPlanRefusedError,
  DeckWorkGoneError,
  readDeckWork,
  removeDeckWork,
  startDeckBuild,
  startDeckOutline,
  stopDeckWork,
} from '@/client/services/deckBuilder/deckBuilder';

import { BrandFinding } from '@/lib/utils/shared/brand/brandFindings';
import {
  DeckPlan,
  checkDeckPlan,
  plannableLayouts,
} from '@/lib/utils/shared/documents/deckPlan';

import { DeckBuilderWorkflowState } from '@/types/workflow';

import { BrandFindingsViewer } from '../BrandReview/BrandFindingsViewer';
import { WorkflowWorkspaceProps } from '../registry';
import { DeckOutlineEditor } from './DeckOutlineEditor';
import { DeckSetup } from './DeckSetup';

import { useConversationStore } from '@/client/stores/conversationStore';

const quietButton =
  'inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800';
const alertBar =
  'border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300';

/** Follows an outline or build. */
function follower<Reading extends DeckOutlineReading | DeckBuildReading>(
  id: string,
): JobFollower<Reading> {
  return {
    read: (signal) => readDeckWork<Reading>(id, signal),
    stop: () => stopDeckWork<Reading>(id),
    isRunning: (reading) => reading.state.status === 'running',
  };
}

/** An error kept as data; worded at render. */
interface WorkspaceError {
  message: string | null;
  fallback: 'readFailed' | 'startFailed' | 'buildFailed';
}

/** A file name from the deck's first title, else the template's name. */
function deckName(plan: DeckPlan, fallback: string): string {
  const title = plan.slides[0]?.fills.find((fill) => fill.kind === 'text');
  const text = title?.kind === 'text' ? title.text.split('\n')[0].trim() : '';
  return (text || fallback).replace(/\.[^.]+$/, '').slice(0, 80);
}

/**
 * The Deck builder workflow (docs/DOCUMENT_PLATFORM.md, phase G): a
 * template, a brief and sources become an outline a model plans; the
 * person edits it; the deck is built from the template's layouts, fitted,
 * rendered and checked against the brand book, then viewed and downloaded.
 * Leaving the page leaves the work running; coming back follows it again.
 */
export function DeckBuilderWorkspace({
  conversationId,
}: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows.deckBuilder');
  const locale = useLocale();
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const ws =
    conversation?.workflowState?.kind === 'deck-builder'
      ? (conversation.workflowState as DeckBuilderWorkflowState)
      : null;

  const setWs = useCallback(
    (changes: Partial<Omit<DeckBuilderWorkflowState, 'kind'>>) =>
      updateWorkflowState(conversationId, (prev) => ({
        ...(prev?.kind === 'deck-builder'
          ? prev
          : {
              kind: 'deck-builder' as const,
              brief: '',
              sources: [],
              pictures: [],
            }),
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

  const outlineJobs = useBackgroundJob<DeckOutlineReading>();
  const buildJobs = useBackgroundJob<DeckBuildReading>();
  const [outline, setOutline] = useState<DeckOutlineReading | null>(null);
  const [build, setBuild] = useState<DeckBuildReading | null>(null);
  const [findings, setFindings] = useState<BrandFinding[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<WorkspaceError | null>(null);

  const outlineId = ws?.outlineId;
  const buildId = ws?.buildId;

  // Follow the conversation's outline, then its build. A new id ends the
  // old follow; an id no longer stored is forgotten.
  useEffect(() => {
    if (!outlineId) return;
    const controller = new AbortController();
    void outlineJobs
      .follow(follower<DeckOutlineReading>(outlineId), {
        onReading: setOutline,
        signal: controller.signal,
      })
      .then((outcome) => {
        if (outcome.error instanceof DeckWorkGoneError) {
          setOutline(null);
          setWs({ outlineId: undefined, buildId: undefined });
        } else if (outcome.error && !isFollowAbort(outcome.error)) {
          setError({
            message:
              outcome.error instanceof Error ? outcome.error.message : null,
            fallback: 'readFailed',
          });
        }
      });
    return () => controller.abort();
  }, [outlineId, outlineJobs, setWs]);

  useEffect(() => {
    if (!buildId) return;
    const controller = new AbortController();
    void buildJobs
      .follow(follower<DeckBuildReading>(buildId), {
        onReading: setBuild,
        signal: controller.signal,
      })
      .then((outcome) => {
        if (outcome.error instanceof DeckWorkGoneError) {
          setBuild(null);
          setWs({ buildId: undefined });
        } else if (outcome.error && !isFollowAbort(outcome.error)) {
          setError({
            message:
              outcome.error instanceof Error ? outcome.error.message : null,
            fallback: 'readFailed',
          });
        }
      });
    return () => controller.abort();
  }, [buildId, buildJobs, setWs]);

  // The finished outline's plan becomes the conversation's, to edit.
  const outlineState = outline?.state ?? null;
  useEffect(() => {
    if (
      outlineState?.status === 'done' &&
      outlineState.plan &&
      ws &&
      !ws.plan
    ) {
      setWs({ plan: outlineState.plan });
    }
  }, [outlineState, ws, setWs]);

  // A finished build's review findings, read once.
  const reviewId = build?.state.reviewId ?? null;
  const buildDone = build?.state.status === 'done';
  useEffect(() => {
    if (!buildDone || !reviewId) {
      setFindings(null);
      return;
    }
    let live = true;
    readBrandReview(reviewId)
      .then((reading) => live && setFindings(reading.state.findings))
      .catch(() => live && setFindings(null));
    return () => {
      live = false;
    };
  }, [buildDone, reviewId]);

  const layouts = useMemo(
    () => (outlineState?.layouts ? plannableLayouts(outlineState.layouts) : []),
    [outlineState?.layouts],
  );
  const pictureKeys = useMemo(
    () => new Set((outlineState?.request.pictures ?? []).map((p) => p.key)),
    [outlineState?.request.pictures],
  );
  const checked = useMemo(
    () =>
      ws?.plan && outlineState?.layouts
        ? checkDeckPlan(
            ws.plan,
            { ...outlineState.layouts, layouts },
            pictureKeys,
          )
        : null,
    [ws?.plan, outlineState?.layouts, layouts, pictureKeys],
  );

  const startOutline = async () => {
    if (!ws?.template) return;
    setStarting(true);
    setError(null);
    try {
      const started = await startDeckOutline({
        template: { file: ws.template.file, name: ws.template.name },
        bookId: ws.bookId,
        brief: ws.brief,
        sources: ws.sources,
        pictures: ws.pictures,
        language: ws.language ?? locale,
      });
      setOutline(started);
      setWs({ outlineId: started.id, plan: undefined, buildId: undefined });
    } catch (err) {
      setError({
        message:
          err instanceof DeckBuilderBusyError
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

  const startBuild = async () => {
    if (!outlineId || !ws?.plan || !outlineState) return;
    setStarting(true);
    setError(null);
    try {
      const started = await startDeckBuild({
        outlineId,
        plan: ws.plan,
        name: deckName(ws.plan, outlineState.request.template.name),
        locale,
      });
      setBuild(started);
      setFindings(null);
      setWs({ buildId: started.id });
    } catch (err) {
      setError({
        message:
          err instanceof DeckPlanRefusedError
            ? err.problems.map((problem) => problem.message).join(' ')
            : err instanceof DeckBuilderBusyError
              ? t('busy', { name: err.activeName ?? '' })
              : err instanceof Error
                ? err.message
                : null,
        fallback: 'buildFailed',
      });
    } finally {
      setStarting(false);
    }
  };

  /** Back to the outline; the build's deck stays the person's upload. */
  const editOutline = async () => {
    const old = buildId;
    setBuild(null);
    setFindings(null);
    setWs({ buildId: undefined });
    if (old) await removeDeckWork(old).catch(() => undefined);
  };

  /** Back to the setup, keeping what the deck was made from. */
  const startOver = async () => {
    const old = [outlineId, buildId].filter(Boolean) as string[];
    setOutline(null);
    setBuild(null);
    setFindings(null);
    setWs({ outlineId: undefined, buildId: undefined, plan: undefined });
    await Promise.all(
      old.map((id) => removeDeckWork(id).catch(() => undefined)),
    );
  };

  const errorText = error ? (error.message ?? t(error.fallback)) : null;

  if (!ws) return null;

  // ── setup ──
  if (!outlineId) {
    return (
      <div className="h-full overflow-y-auto">
        <DeckSetup
          ws={ws}
          books={booksQuery.data ?? []}
          booksLoading={booksQuery.isLoading}
          uiLocale={locale}
          onChange={setWs}
          onStart={() => void startOutline()}
          starting={starting}
          error={errorText ?? (booksQuery.error ? t('booksFailed') : null)}
        />
      </div>
    );
  }

  if (!outlineState) {
    return (
      <p className="p-6 text-sm text-gray-500" role="status">
        {errorText ?? t('loading')}
      </p>
    );
  }

  const header = (
    title: string,
    subtitle: string,
    status: React.ReactNode,
    actions: React.ReactNode,
  ) => (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-800">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
          {subtitle}
        </p>
      </div>
      <div
        className="text-xs text-gray-600 dark:text-gray-300"
        role="status"
        aria-live="polite"
      >
        {status}
      </div>
      {actions}
    </header>
  );
  const spinning = (text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <IconLoader size={14} className="animate-spin" aria-hidden />
      {text}
    </span>
  );
  const templateName = outlineState.request.template.name;
  const subtitle = outlineState.request.book
    ? t('forBook', {
        template: templateName,
        book: outlineState.request.book.name,
      })
    : t('fromTemplate', { template: templateName });

  // ── build ──
  if (buildId && build) {
    const state = build.state;
    const running = state.status === 'running';
    const unfit = [
      ...new Set(
        state.report?.units
          .filter((unit) => !unit.fits)
          .map((unit) => unit.page),
      ),
    ];
    const shrunk = new Set(
      state.report?.units
        .filter((unit) => unit.scale < 1)
        .map((unit) => unit.page),
    ).size;
    const status = running
      ? spinning(t(`buildPhase.${state.phase}`))
      : state.status === 'done'
        ? state.review
          ? t('reviewed', {
              errors: state.review.error,
              warnings: state.review.warning,
            })
          : state.request.book
            ? t(`reviewGap.${state.reviewGap ?? 'failed'}`)
            : t('built')
        : t(`status.${state.status}`);
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header(
          `${state.request.name}.pptx`,
          subtitle,
          status,
          running ? (
            <button
              type="button"
              className={quietButton}
              onClick={() => buildJobs.stop()}
            >
              <IconPlayerStop size={16} aria-hidden />
              {t('stop')}
            </button>
          ) : (
            <>
              {state.file && (
                <a
                  className={quietButton}
                  href={`${state.file}?filetype=file`}
                  download={`${state.request.name}.pptx`}
                >
                  <IconDownload size={16} aria-hidden />
                  {t('download')}
                </a>
              )}
              <button
                type="button"
                className={quietButton}
                onClick={() => void editOutline()}
              >
                <IconPencil size={16} aria-hidden />
                {t('editOutline')}
              </button>
              <button
                type="button"
                className={quietButton}
                onClick={() => void startOver()}
              >
                <IconPlus size={16} aria-hidden />
                {t('newDeck')}
              </button>
            </>
          ),
        )}
        {state.status === 'failed' && (
          <p className={alertBar} role="alert">
            {state.error ?? t('buildFailed')}
          </p>
        )}
        {errorText && (
          <p className={alertBar} role="alert">
            {errorText}
          </p>
        )}
        {state.status === 'done' && (shrunk > 0 || unfit.length > 0) && (
          <p className="border-b border-gray-200 px-4 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-400">
            {unfit.length > 0
              ? t('overflows', {
                  count: unfit.length,
                  slides: unfit.join(', '),
                })
              : t('shrunk', { count: shrunk })}
          </p>
        )}
        <div className="min-h-0 flex-1">
          {state.file && !running && (
            <BrandFindingsViewer
              key={state.file}
              document={{
                file: state.file,
                name: `${state.request.name}.pptx`,
                type: 'pptx',
              }}
              findings={findings ?? []}
            />
          )}
        </div>
      </div>
    );
  }

  // ── outline ──
  const outlineRunning = outlineState.status === 'running';
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header(
        t('outlineTitle'),
        subtitle,
        outlineRunning
          ? spinning(t(`outlinePhase.${outlineState.phase}`))
          : outlineState.status === 'done' && ws.plan
            ? t('outlineReady', { count: ws.plan.slides.length })
            : t(`status.${outlineState.status}`),
        outlineRunning ? (
          <button
            type="button"
            className={quietButton}
            onClick={() => outlineJobs.stop()}
          >
            <IconPlayerStop size={16} aria-hidden />
            {t('stop')}
          </button>
        ) : (
          <button
            type="button"
            className={quietButton}
            onClick={() => void startOver()}
          >
            <IconArrowLeft size={16} aria-hidden />
            {t('startOver')}
          </button>
        ),
      )}
      {outlineState.status === 'failed' && (
        <p className={alertBar} role="alert">
          {outlineState.error ?? t('outlineFailed')}
        </p>
      )}
      {outlineState.unread.length > 0 && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          {t('unread', {
            names: outlineState.unread.map((source) => source.name).join(', '),
          })}
        </p>
      )}
      {outlineState.status === 'done' && outlineState.repaired.length > 0 && (
        <p className="border-b border-gray-200 px-4 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-400">
          {t('repaired', { count: outlineState.repaired.length })}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ws.plan && checked && (
          <DeckOutlineEditor
            layouts={layouts}
            plan={ws.plan}
            checked={checked}
            pictures={outlineState.request.pictures}
            onChange={(plan) => setWs({ plan })}
            onBuild={() => void startBuild()}
            building={starting || (!!buildId && !build)}
            error={errorText}
          />
        )}
      </div>
    </div>
  );
}
