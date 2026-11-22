/**
 * Where a person's deck outlines and builds live, and how they are
 * started, read, stopped and removed. The routes in app/api/deck-builder
 * are thin over this.
 *
 * An outline is kept at `<user>/deck-outlines/<id>/`, a build at
 * `<user>/deck-builds/<id>/`; a built deck is the person's upload, so the
 * viewer, downloads and brand reviews take it as any other.
 */
import { Session } from 'next-auth';

import { AdminBrandBook } from '@/lib/services/agentAccess/types';
import { personJobs } from '@/lib/services/backgroundJobs/personJobs';
import {
  readBrandReview,
  removeBrandReview,
  startBrandReview,
} from '@/lib/services/brand/brandReviews';
import {
  composeDeck,
  readDeckLayouts,
} from '@/lib/services/documents/model/deckEngine';
import { documentPdf } from '@/lib/services/documents/render/documentPages';
import { storeUploadedFile } from '@/lib/services/documents/sources/documentSources';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import { getPdfPageCount } from '@/lib/utils/server/file/pdfUtils';
import {
  DeckPlan,
  DeckPlanProblem,
  checkDeckPlan,
} from '@/lib/utils/shared/documents/deckPlan';

import {
  DECK_BUILD_JOB_KIND,
  DECK_OUTLINE_JOB_KIND,
  DeckBookSnapshot,
  DeckBuildContext,
  DeckBuildRequest,
  DeckBuildState,
  DeckOutlineContext,
  DeckOutlineRequest,
  DeckOutlineState,
} from './deckBuilderJobs';
import {
  DECK_PICTURE_TYPES,
  DECK_SOURCE_TYPES,
  DeckInputError,
  DeckTemplateRef,
  DeckUpload,
  MAX_DECK_SOURCES,
  deckPictures,
  deckTemplateType,
  parseDeckUpload,
  readDeckFile,
  readSourceText,
} from './deckInputs';
import { MAX_BRIEF_CHARS, planDeck } from './deckPlanner';

import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** An outline's id: `outline-` and 12 hex digits. */
export const OUTLINE_ID_PATTERN = /^outline-[a-f0-9]{12}$/;
/** A build's id: `deck-` and 12 hex digits. */
export const BUILD_ID_PATTERN = /^deck-[a-f0-9]{12}$/;

const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Raised when an edited plan cannot be built; it lists why. */
export class DeckPlanBlockedError extends Error {
  constructor(readonly problems: DeckPlanProblem[]) {
    super('The outline cannot be built as it is.');
    this.name = 'DeckPlanBlockedError';
  }
}

function snapshotOf(book: AdminBrandBook | null): DeckBookSnapshot | null {
  return book
    ? {
        id: book.id,
        name: book.book.name,
        updatedAt: book.updatedAt,
        body: book.book,
      }
    : null;
}

function outlineContext(
  session: Session,
  request: DeckOutlineRequest,
): DeckOutlineContext {
  return {
    user: session.user,
    deps: {
      readTemplate: async () => {
        const data = await readDeckFile(
          session,
          request.template.file,
          request.book?.id ?? null,
        );
        if (!data) throw new Error('The template is no longer stored.');
        return data;
      },
      readSource: (source) => readSourceText(session, source),
      readLayouts: readDeckLayouts,
      plan: planDeck,
      model: resolveWorkflowModelId(),
    },
  };
}

/** Pages of a deck as the render service draws it. */
async function renderedPages(
  deck: Uint8Array,
  signal: AbortSignal,
): Promise<number> {
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'deck-build-'),
  );
  try {
    const inputPath = path.join(workDir, 'deck.pptx');
    await fs.promises.writeFile(inputPath, deck);
    const pdf = await documentPdf(inputPath, 'pptx', {
      lane: 'background',
      workDir,
      signal,
    });
    return await getPdfPageCount(pdf);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

function buildContext(
  session: Session,
  request: DeckBuildRequest,
): DeckBuildContext {
  return {
    user: session.user,
    deps: {
      readTemplate: async () => {
        const data = await readDeckFile(
          session,
          request.template.file,
          request.book?.id ?? null,
        );
        if (!data) throw new Error('The template is no longer stored.');
        return data;
      },
      readPicture: (picture) =>
        readDeckFile(session, picture.file, request.book?.id ?? null),
      compose: composeDeck,
      renderedPages,
      store: (deck) =>
        storeUploadedFile(session, deck, 'pptx', PPTX_CONTENT_TYPE),
      startReview: async (file) => {
        const book = request.book!;
        const started = await startBrandReview(
          session,
          { id: book.id, book: book.body, updatedAt: book.updatedAt },
          { file, name: `${request.name}.pptx`, type: 'pptx' },
          { modelReview: false, noteLocale: request.noteLocale },
        );
        return started.reviewId;
      },
      readReview: (reviewId) => readBrandReview(session, reviewId),
      pause: (ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
  };
}

const outlines = personJobs(
  DECK_OUTLINE_JOB_KIND,
  'deck-outlines',
  outlineContext,
);
const builds = personJobs(DECK_BUILD_JOB_KIND, 'deck-builds', buildContext);

/** What an outline is asked for, as the route read it. */
export interface DeckOutlineInput {
  template: DeckTemplateRef;
  /** The book the deck is for (the caller checked the person may use it). */
  book: AdminBrandBook | null;
  brief: string;
  sources: DeckUpload[];
  pictures: DeckUpload[];
  language: string;
}

/**
 * Starts an outline.
 *
 * @throws DeckInputError for a template, source or picture that cannot be
 *   used; JobActiveError when the person's outlines are all running.
 */
export async function startDeckOutline(
  session: Session,
  input: DeckOutlineInput,
): Promise<{ outlineId: string; state: DeckOutlineState }> {
  const book = snapshotOf(input.book);
  const type = deckTemplateType(input.template.file, book?.body ?? null);
  if (!type) {
    throw new DeckInputError(
      'The template must be a .pptx or .potx of yours or of the brand book.',
    );
  }
  if (!input.brief.trim())
    throw new DeckInputError('Say what the deck is for.');
  if (input.sources.length > MAX_DECK_SOURCES) {
    throw new DeckInputError(`At most ${MAX_DECK_SOURCES} sources are read.`);
  }
  for (const source of input.sources) {
    if (!parseDeckUpload(source.file, DECK_SOURCE_TYPES)) {
      throw new DeckInputError(
        `${source.name} is not a document that can be read.`,
      );
    }
  }
  for (const picture of input.pictures) {
    if (!parseDeckUpload(picture.file, DECK_PICTURE_TYPES)) {
      throw new DeckInputError(`${picture.name} is not a PNG, JPEG or GIF.`);
    }
  }
  const outlineId = `outline-${randomBytes(6).toString('hex')}`;
  const request: DeckOutlineRequest = {
    template: { ...input.template, type },
    book,
    brief: input.brief.slice(0, MAX_BRIEF_CHARS),
    sources: input.sources,
    pictures: deckPictures(book?.body ?? null, input.pictures),
    language: input.language,
  };
  const state = await outlines.start(session, outlineId, request);
  return { outlineId, state };
}

/**
 * Starts building a deck from a finished outline and the plan as the
 * person left it, checked again against the outline's layouts.
 *
 * @returns Null when the person has no such finished outline.
 * @throws DeckPlanBlockedError when the plan cannot be built;
 *   JobActiveError when the person's builds are all running.
 */
export async function startDeckBuild(
  session: Session,
  input: {
    outlineId: string;
    plan: DeckPlan;
    name: string;
    noteLocale: string;
  },
): Promise<{ buildId: string; state: DeckBuildState } | null> {
  const outline = await outlines.read(session, input.outlineId);
  if (!outline || outline.status !== 'done' || !outline.layouts) return null;
  const checked = checkDeckPlan(
    input.plan,
    outline.layouts,
    new Set(outline.request.pictures.map((picture) => picture.key)),
  );
  if (checked.blocking.length > 0)
    throw new DeckPlanBlockedError(checked.blocking);
  const buildId = `deck-${randomBytes(6).toString('hex')}`;
  const request: DeckBuildRequest = {
    outlineId: input.outlineId,
    template: outline.request.template,
    book: outline.request.book,
    plan: checked.plan,
    pictures: outline.request.pictures,
    language: outline.request.language,
    name: input.name,
    noteLocale: input.noteLocale,
  };
  const state = await builds.start(session, buildId, request);
  return { buildId, state };
}

/** The outline or build an id names, read (and picked up when stalled). */
export function readDeckJob(
  session: Session,
  id: string,
): Promise<DeckOutlineState | DeckBuildState | null> {
  if (OUTLINE_ID_PATTERN.test(id)) return outlines.read(session, id);
  if (BUILD_ID_PATTERN.test(id)) return builds.read(session, id);
  return Promise.resolve(null);
}

/** Asks an outline or build to stop. */
export function stopDeckJob(
  session: Session,
  id: string,
): Promise<DeckOutlineState | DeckBuildState | null> {
  if (OUTLINE_ID_PATTERN.test(id)) return outlines.stop(session, id);
  if (BUILD_ID_PATTERN.test(id)) return builds.stop(session, id);
  return Promise.resolve(null);
}

/**
 * Removes an outline, or a build with the brand review it started (a
 * built deck stays the person's upload).
 *
 * @returns Whether there was anything under the id.
 */
export async function removeDeckJob(
  session: Session,
  id: string,
): Promise<boolean> {
  if (OUTLINE_ID_PATTERN.test(id)) return outlines.remove(session, id);
  if (!BUILD_ID_PATTERN.test(id)) return false;
  const build = await builds.read(session, id);
  if (build?.reviewId) await removeBrandReview(session, build.reviewId);
  return builds.remove(session, id);
}
