/**
 * The deck builder's two background jobs (THE JOB CONVENTION,
 * backgroundJobs.ts; docs/DOCUMENT_PLATFORM.md, phase G):
 *
 *   outline  reads the template's layouts and the sources, and plans the
 *            deck with a model (deckPlanner.ts). The person edits the plan.
 *   build    composes the deck from the template and the edited plan,
 *            renders it (it must open, one page per planned slide), keeps
 *            it as the person's upload, and runs a brand review on it when
 *            built for a brand book, waiting for the review's findings
 *            before it is offered.
 *
 * Each step keeps what it made, so a build picked up again after a restart
 * starts over from the plan (a deck is built whole or not at all).
 */
import { Session } from 'next-auth';

import {
  JobActiveError,
  JobKind,
  JobRun,
  JobStateBase,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import type { BrandReviewState } from '@/lib/services/brand/brandReviewJob';
import type {
  DeckComposeReport,
  composeDeck,
  readDeckLayouts,
} from '@/lib/services/documents/model/deckEngine';
import { DocumentRefusedError } from '@/lib/services/documents/model/inspect';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { BrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import {
  BrandFindingSeverity,
  countBySeverity,
} from '@/lib/utils/shared/brand/brandFindings';
import {
  DeckLayouts,
  DeckPlan,
  DeckPlanProblem,
} from '@/lib/utils/shared/documents/deckPlan';

import type { DeckPicture, DeckTemplateRef, DeckUpload } from './deckInputs';
import type { planDeck } from './deckPlanner';

/** The book a deck is built for, as it was when the work started. */
export interface DeckBookSnapshot {
  id: string;
  name: string;
  updatedAt: string;
  body: BrandBookBody;
}

/** The token totals, as the workflow usage echo reports them. */
type DeckUsage = NonNullable<ReturnType<WorkflowUsageCollector['payload']>>;

// ── outline ──────────────────────────────────────────────────────────────

export interface DeckOutlineRequest {
  template: DeckTemplateRef;
  book: DeckBookSnapshot | null;
  brief: string;
  sources: DeckUpload[];
  /** The pictures the deck may place (THE PICTURE KEYS, deckInputs.ts). */
  pictures: DeckPicture[];
  /** BCP 47 tag the deck is written in. */
  language: string;
}

export type DeckOutlinePhase = 'template' | 'reading' | 'planning';

export interface DeckOutlineState extends JobStateBase {
  request: DeckOutlineRequest;
  phase: DeckOutlinePhase;
  layouts: DeckLayouts | null;
  plan: DeckPlan | null;
  /** What the check changed in the model's plan. */
  repaired: DeckPlanProblem[];
  /** What the person must resolve before building. */
  blocking: DeckPlanProblem[];
  /** Sources that could not be read, by name, with why. */
  unread: Array<{ name: string; reason: string }>;
  usage?: DeckUsage;
}

/** What the outline needs from the world; replaced in tests. */
export interface DeckOutlineDeps {
  readTemplate(): Promise<Buffer>;
  readSource(source: DeckUpload): Promise<string>;
  readLayouts: typeof readDeckLayouts;
  plan: typeof planDeck;
  /** The text model the plan is made with. */
  model: string;
}

export interface DeckOutlineContext {
  user: Session['user'];
  deps: DeckOutlineDeps;
}

async function runOutline(
  job: JobRun<DeckOutlineState>,
  { user, deps }: DeckOutlineContext,
): Promise<void> {
  const { request } = job.state();
  const usage = new WorkflowUsageCollector({ user, action: 'deck-builder' });
  const template = await job.untilStopped(deps.readTemplate());
  const layouts = await job.untilStopped(deps.readLayouts(template, usage));
  job.update({ phase: 'reading', layouts, ...usage.fields() });
  await job.save();

  const sources: Array<{ name: string; text: string }> = [];
  const unread: DeckOutlineState['unread'] = [];
  for (const source of request.sources) {
    try {
      sources.push({
        name: source.name,
        text: await job.untilStopped(deps.readSource(source)),
      });
    } catch (error) {
      if (job.signal.aborted) throw error;
      unread.push({
        name: source.name,
        reason: error instanceof Error ? error.message : 'Could not be read.',
      });
    }
  }
  job.update({ phase: 'planning', unread });
  await job.save();

  const checked = await job.untilStopped(
    deps.plan({
      brief: request.brief,
      sources,
      layouts,
      pictures: request.pictures,
      book: request.book?.body ?? null,
      language: request.language,
      model: deps.model,
      usage,
    }),
  );
  job.update({
    plan: checked.plan,
    repaired: checked.repaired,
    blocking: checked.blocking,
    ...usage.fields(),
  });
}

/** THE JOB CONVENTION's description of a deck outline. */
export const DECK_OUTLINE_JOB_KIND: JobKind<
  DeckOutlineRequest,
  DeckOutlineState,
  DeckOutlineContext
> = {
  kind: 'deck-outline',
  version: 1,
  limitPerPerson: 2,
  label: (request) => request.template.name,
  initial: () => ({
    phase: 'template',
    layouts: null,
    plan: null,
    repaired: [],
    blocking: [],
    unread: [],
  }),
  // A finished outline keeps its plan; one picked up again plans anew.
  settle: (state) =>
    state.status === 'running'
      ? { ...state, phase: 'template', plan: null, repaired: [], blocking: [] }
      : state,
  failureMessage: 'The outline could not be made.',
  run: runOutline,
};

// ── build ────────────────────────────────────────────────────────────────

export interface DeckBuildRequest {
  /** The outline the plan was made from (its layouts were checked). */
  outlineId: string;
  template: DeckTemplateRef;
  book: DeckBookSnapshot | null;
  /** The plan as the person left it, checked against the layouts. */
  plan: DeckPlan;
  pictures: DeckPicture[];
  language: string;
  /** The deck's file name, without extension. */
  name: string;
  /** The reader's locale, for the review's notes. */
  noteLocale: string;
}

export type DeckBuildPhase =
  | 'composing'
  | 'rendering'
  | 'storing'
  | 'reviewing';

/** Why a deck built for a book has no review. */
export type DeckReviewGap = 'busy' | 'failed' | null;

export interface DeckBuildState extends JobStateBase {
  request: DeckBuildRequest;
  phase: DeckBuildPhase;
  /** The built deck, the person's upload: `/api/file/<sha256>.pptx`. */
  file: string | null;
  report: DeckComposeReport | null;
  /** The brand review of the deck, when built for a book. */
  reviewId: string | null;
  /** Its findings by severity. */
  review: Record<BrandFindingSeverity, number> | null;
  reviewGap: DeckReviewGap;
  usage?: DeckUsage;
}

/** What a build needs from the world; replaced in tests. */
export interface DeckBuildDeps {
  readTemplate(): Promise<Buffer>;
  /** A picture's bytes by its key, or null when it is gone. */
  readPicture(picture: DeckPicture): Promise<Uint8Array | null>;
  compose: typeof composeDeck;
  /** Pages of the deck as rendered (the render service's PDF). */
  renderedPages(deck: Uint8Array, signal: AbortSignal): Promise<number>;
  /** Keeps the deck as the person's upload; returns its reference. */
  store(deck: Uint8Array): Promise<string>;
  /**
   * Starts a brand review of the stored deck.
   *
   * @throws JobActiveError when the person's reviews are all running.
   */
  startReview(file: string): Promise<string>;
  readReview(reviewId: string): Promise<BrandReviewState | null>;
  /** Waits between reads of the review. */
  pause(ms: number, signal: AbortSignal): Promise<void>;
}

export interface DeckBuildContext {
  user: Session['user'];
  deps: DeckBuildDeps;
}

/** How often a build reads the review it waits for. */
export const REVIEW_POLL_MS = 3_000;

/** Raised when the rendered deck is not the deck planned. */
export class DeckRenderMismatchError extends Error {
  constructor(planned: number, rendered: number) {
    super(`The deck rendered ${rendered} pages for ${planned} planned slides.`);
    this.name = 'DeckRenderMismatchError';
  }
}

async function runBuild(
  job: JobRun<DeckBuildState>,
  { user, deps }: DeckBuildContext,
): Promise<void> {
  const { request } = job.state();
  const usage = new WorkflowUsageCollector({ user, action: 'deck-builder' });
  const template = await job.untilStopped(deps.readTemplate());
  const used = new Set(
    request.plan.slides.flatMap((slide) =>
      slide.fills.flatMap((fill) =>
        fill.kind === 'image' ? [fill.image] : [],
      ),
    ),
  );
  const pictures = new Map<string, Uint8Array>();
  for (const picture of request.pictures.filter((p) => used.has(p.key))) {
    const bytes = await job.untilStopped(deps.readPicture(picture));
    if (!bytes)
      throw new Error(`The picture ${picture.name} is no longer stored.`);
    pictures.set(picture.key, bytes);
  }
  let built: Awaited<ReturnType<typeof composeDeck>>;
  try {
    built = await job.untilStopped(
      deps.compose(
        template,
        request.plan,
        pictures,
        { language: request.language },
        usage,
      ),
    );
  } catch (error) {
    // The engine's refusal says what in the plan or template it could not use.
    if (error instanceof DocumentRefusedError) throw new Error(error.message);
    throw error;
  }
  job.update({ phase: 'rendering', report: built.report, ...usage.fields() });
  await job.save();

  const pages = await job.untilStopped(
    deps.renderedPages(built.deck, job.signal),
  );
  if (pages !== request.plan.slides.length) {
    throw new DeckRenderMismatchError(request.plan.slides.length, pages);
  }
  job.update({ phase: 'storing' });
  const file = await job.untilStopped(deps.store(built.deck));
  job.update({ file });
  await job.save();
  if (!request.book) return;

  job.update({ phase: 'reviewing' });
  let reviewId: string;
  try {
    reviewId = await job.untilStopped(deps.startReview(file));
  } catch (error) {
    if (error instanceof JobActiveError) {
      job.update({ reviewGap: 'busy' });
      return;
    }
    throw error;
  }
  job.update({ reviewId });
  await job.save();
  for (;;) {
    const review = await job.untilStopped(deps.readReview(reviewId));
    if (!review || review.status === 'failed') {
      job.update({ reviewGap: 'failed' });
      return;
    }
    if (review.status !== 'running') {
      job.update({ review: countBySeverity(review.findings) });
      return;
    }
    await deps.pause(REVIEW_POLL_MS, job.signal);
  }
}

/** THE JOB CONVENTION's description of a deck build. */
export const DECK_BUILD_JOB_KIND: JobKind<
  DeckBuildRequest,
  DeckBuildState,
  DeckBuildContext
> = {
  kind: 'deck-build',
  version: 1,
  limitPerPerson: 2,
  label: (request) => request.name,
  initial: () => ({
    phase: 'composing',
    file: null,
    report: null,
    reviewId: null,
    review: null,
    reviewGap: null,
  }),
  // A build picked up again starts over from the plan.
  settle: (state) =>
    state.status === 'running'
      ? {
          ...state,
          phase: 'composing',
          file: null,
          report: null,
          reviewId: null,
          review: null,
          reviewGap: null,
        }
      : state,
  failureMessage: 'The deck could not be built.',
  run: runBuild,
};
