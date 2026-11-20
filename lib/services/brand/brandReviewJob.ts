/**
 * A brand review as a background job (THE JOB CONVENTION in
 * lib/services/backgroundJobs/backgroundJobs.ts; docs/DOCUMENT_PLATFORM.md,
 * phase F): read the document, check its text, match and check its
 * logos, then have a model look at each page. Findings are saved page by
 * page, so a reader watching the job sees them arrive and a stopped job
 * keeps what it found.
 *
 * The request carries a SNAPSHOT of the brand book, taken when the route
 * checked the person may use it: a review answers to the book as it was
 * when it started, and the job never re-checks access without the
 * person's request.
 */
import { Session } from 'next-auth';

import {
  JobKind,
  JobRun,
  JobStateBase,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import { inspectDocument } from '@/lib/services/documents/model/inspect';
import {
  PagedDocumentType,
  documentPagePictures,
} from '@/lib/services/documents/render/documentPages';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { BrandBookBody, BrandLogo } from '@/lib/utils/shared/brand/brandBook';
import { checkDocumentText } from '@/lib/utils/shared/brand/brandChecks';
import {
  BrandFinding,
  sortFindings,
} from '@/lib/utils/shared/brand/brandFindings';
import { checkLogoPlacement } from '@/lib/utils/shared/brand/logoChecks';
import {
  DOCUMENT_MODEL_SCHEME,
  DocumentImage,
  DocumentModel,
  DocumentPageInfo,
} from '@/lib/utils/shared/documents/documentModel';

import { reviewPage } from './brandPageReview';
import {
  PictureSignature,
  backgroundAround,
  matchLogo,
  pictureSignature,
} from './logoMatch';

import fs from 'fs';
import os from 'os';
import path from 'path';

export const BRAND_REVIEW_JOB_VERSION = 1;
/** Pages a model looks at in one review; the rest are checked without it. */
export const MAX_MODEL_PAGES = 40;
/** Page pictures made per render job: small enough to stop between. */
const PICTURE_BATCH = 4;
const PICTURE_DPI = 110;
/** Pictures smaller than this (either side, pixels) are never logos. */
const MIN_LOGO_PIXELS = 16;
/** An unmatched picture is shown to the model when at most this share of the page. */
const LOGO_LIKE_PAGE_SHARE = 0.25;
/** Logos shown to the model with each page. */
const LOGOS_SHOWN = 3;

/** What a review is asked to do; fixed when it starts. */
export interface BrandReviewRequest {
  book: { id: string; name: string; updatedAt: string; body: BrandBookBody };
  /** The person's upload: `/api/file/<sha256>.<ext>`. */
  file: string;
  /** The file's name as the person knows it. */
  name: string;
  /** Its type (extension, no dot). */
  type: string;
  /** Whether a model looks at each page. */
  modelReview: boolean;
}

export type BrandReviewPhase = 'reading' | 'checking' | 'reviewing';

/** The review's token totals, as the workflow usage echo reports them. */
type BrandReviewUsage = NonNullable<
  ReturnType<WorkflowUsageCollector['payload']>
>;

export interface BrandReviewState extends JobStateBase {
  request: BrandReviewRequest;
  phase: BrandReviewPhase;
  /** THE DOCUMENT MODEL's id scheme the findings were made with. */
  scheme: number;
  pageCount: number;
  /** Page sizes in points, for drawing findings over pictures. */
  pages: DocumentPageInfo[];
  /** Pages the model has looked at. */
  reviewedPages: number[];
  /** Pages the model did not look at (over MAX_MODEL_PAGES, or failed). */
  skippedPages: number[];
  findings: BrandFinding[];
  usage?: BrandReviewUsage;
}

/** What the work needs from the world; replaced in tests. */
export interface BrandReviewDeps {
  readDocument(): Promise<Buffer>;
  /** A stored file of the book, or null when it is gone. */
  readLogo(file: string): Promise<Uint8Array | null>;
  inspect: typeof inspectDocument;
  pagePictures: typeof documentPagePictures;
  reviewPage: typeof reviewPage;
  /** The vision model the page review uses. */
  model: string;
}

export interface BrandReviewContext {
  user: Session['user'];
  deps: BrandReviewDeps;
}

/** A book logo ready to be matched. */
interface LoadedLogo {
  logo: BrandLogo;
  signature: PictureSignature;
  dataUrl: string;
}

async function loadLogos(
  book: BrandBookBody,
  deps: BrandReviewDeps,
): Promise<LoadedLogo[]> {
  const loaded: LoadedLogo[] = [];
  for (const logo of book.logos) {
    const bytes = await deps.readLogo(logo.file);
    if (!bytes) continue;
    const signature = await pictureSignature(bytes);
    if (!signature) continue;
    const type = logo.file.endsWith('.svg')
      ? 'image/svg+xml'
      : logo.file.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';
    loaded.push({
      logo,
      signature,
      dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}`,
    });
  }
  return loaded;
}

/** A picture's match, worked out once per distinct picture (by hash). */
interface PictureMatch {
  logo: LoadedLogo | null;
  logoSized: boolean;
}

async function matchPictures(
  inspected: {
    model: DocumentModel;
    imageFile: (file: string) => Uint8Array | null;
  },
  logos: readonly LoadedLogo[],
): Promise<Map<string, PictureMatch>> {
  const matches = new Map<string, PictureMatch>();
  for (const image of inspected.model.images) {
    if (matches.has(image.sha256)) continue;
    const bytes = inspected.imageFile(image.file);
    const signature = bytes ? await pictureSignature(bytes) : null;
    const logoSized =
      !!signature &&
      signature.width >= MIN_LOGO_PIXELS &&
      signature.height >= MIN_LOGO_PIXELS;
    const match =
      signature && logoSized && logos.length > 0
        ? matchLogo(
            signature,
            logos.map((logo) => ({ key: logo, signature: logo.signature })),
          )
        : null;
    matches.set(image.sha256, { logo: match?.key ?? null, logoSized });
  }
  return matches;
}

/** Whether an unmatched picture could be a logo the matcher missed. */
function logoLike(
  image: DocumentImage,
  page: DocumentPageInfo | undefined,
): boolean {
  if (!image.box || !page) return false;
  const area = (image.box[2] - image.box[0]) * (image.box[3] - image.box[1]);
  return area > 0 && area <= page.width * page.height * LOGO_LIKE_PAGE_SHARE;
}

/** Runs the review (see the module comment). */
async function runReview(
  job: JobRun<BrandReviewState>,
  { user, deps }: BrandReviewContext,
): Promise<void> {
  const { request } = job.state();
  const book = request.book.body;
  const usage = new WorkflowUsageCollector({ user, action: 'brand-review' });
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'brand-review-'),
  );
  try {
    const data = await job.untilStopped(deps.readDocument());
    const inputPath = path.join(workDir, `document.${request.type}`);
    await fs.promises.writeFile(inputPath, data);
    const inspected = await job.untilStopped(
      deps.inspect(data, request.type, {
        lane: 'background',
        workDir,
        usage,
        signal: job.signal,
      }),
    );
    const { model } = inspected;
    const pageInfo = new Map(model.pages.map((page) => [page.page, page]));

    job.update({
      phase: 'checking',
      pageCount: model.pageCount,
      pages: model.pages,
      findings: checkDocumentText(model, book),
    });
    await job.save();

    const logos = await loadLogos(book, deps);
    const matches = await matchPictures(inspected, logos);
    const placed = model.images.filter((image) => image.page !== null);
    const matchedOn = (page: number) =>
      placed.filter(
        (image) => image.page === page && matches.get(image.sha256)?.logo,
      );

    // Pages a picture is needed for: every page the model reviews, and
    // pages with a matched logo whose background matters.
    const allPages = Array.from({ length: model.pageCount }, (_, i) => i + 1);
    const modelPages = request.modelReview
      ? allPages
          .filter((page) => !pageInfo.get(page)?.hidden)
          .slice(0, MAX_MODEL_PAGES)
      : [];
    const backgroundPages = allPages.filter((page) =>
      matchedOn(page).some(
        (image) =>
          (matches.get(image.sha256)?.logo?.logo.allowedColors.length ?? 0) > 0,
      ),
    );
    const picturePages = [...new Set([...modelPages, ...backgroundPages])].sort(
      (a, b) => a - b,
    );
    const skippedPages = request.modelReview
      ? allPages.filter((page) => !modelPages.includes(page))
      : [];
    job.update({ phase: 'reviewing', skippedPages });

    // Logos on pages that need no picture are checked without a background.
    for (const page of allPages.filter(
      (page) => !picturePages.includes(page),
    )) {
      for (const image of matchedOn(page)) {
        const match = matches.get(image.sha256)!.logo!;
        job.update((state) => ({
          ...state,
          findings: [
            ...state.findings,
            ...checkLogoPlacement({
              image,
              logo: match.logo,
              logoAspect: match.signature.aspect,
              background: null,
            }),
          ],
        }));
      }
    }
    await job.save();

    for (let start = 0; start < picturePages.length; start += PICTURE_BATCH) {
      const batch = picturePages.slice(start, start + PICTURE_BATCH);
      const pictures = await job.untilStopped(
        deps.pagePictures({
          inputPath,
          type: request.type as PagedDocumentType,
          pages: batch,
          dpi: PICTURE_DPI,
          lane: 'background',
          workDir,
          signal: job.signal,
        }),
      );
      for (const page of batch) {
        const picture = pictures.get(page);
        const info = pageInfo.get(page);
        const found: BrandFinding[] = [];
        for (const image of matchedOn(page)) {
          const match = matches.get(image.sha256)!.logo!;
          const background =
            picture && info && image.box && match.logo.allowedColors.length > 0
              ? await backgroundAround(picture, info, image.box)
              : null;
          found.push(
            ...checkLogoPlacement({
              image,
              logo: match.logo,
              logoAspect: match.signature.aspect,
              background,
            }),
          );
        }
        let reviewed = false;
        if (picture && modelPages.includes(page)) {
          try {
            found.push(
              ...(await job.untilStopped(
                deps.reviewPage({
                  page,
                  picture,
                  units: model.units.filter(
                    (unit) =>
                      unit.page === page &&
                      unit.kind !== 'layout' &&
                      unit.kind !== 'master',
                  ),
                  pictures: placed.filter(
                    (image) =>
                      image.page === page &&
                      !matches.get(image.sha256)?.logo &&
                      matches.get(image.sha256)?.logoSized &&
                      logoLike(image, info),
                  ),
                  book,
                  logos: logos
                    .slice(0, LOGOS_SHOWN)
                    .map((logo) => logo.dataUrl),
                  model: deps.model,
                  usage,
                }),
              )),
            );
            reviewed = true;
          } catch (error) {
            if (job.signal.aborted) throw error;
            // One page the model could not review does not fail the rest.
            console.warn(
              `[brandReview] page ${page} model review failed:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
        job.update((state) => ({
          ...state,
          findings: [...state.findings, ...found],
          reviewedPages: reviewed
            ? [...state.reviewedPages, page]
            : state.reviewedPages,
          skippedPages:
            modelPages.includes(page) && !reviewed
              ? [...state.skippedPages, page]
              : state.skippedPages,
          ...usage.fields(),
        }));
        await job.save();
      }
    }
    job.update((state) => ({
      ...state,
      findings: sortFindings(state.findings),
      ...usage.fields(),
    }));
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

/** THE JOB CONVENTION's description of a brand review. */
export const BRAND_REVIEW_JOB_KIND: JobKind<
  BrandReviewRequest,
  BrandReviewState,
  BrandReviewContext
> = {
  kind: 'brand-review',
  version: BRAND_REVIEW_JOB_VERSION,
  limitPerPerson: 2,
  label: (request) => request.name,
  initial: () => ({
    phase: 'reading',
    scheme: DOCUMENT_MODEL_SCHEME,
    pageCount: 0,
    pages: [],
    reviewedPages: [],
    skippedPages: [],
    findings: [],
  }),
  // Called when a job ends and when one is picked up again: a finished
  // review keeps its record; one picked up again starts over and makes
  // its findings again.
  settle: (state) =>
    state.status === 'running'
      ? {
          ...state,
          phase: 'reading',
          reviewedPages: [],
          skippedPages: [],
          findings: [],
        }
      : state,
  failureMessage: 'The brand review failed.',
  run: runReview,
};
