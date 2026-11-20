import {
  JobSlotRecord,
  JobSlots,
  JobStore,
  jobInProcess,
  startJob,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import {
  BRAND_REVIEW_JOB_KIND,
  BrandReviewDeps,
  BrandReviewRequest,
  BrandReviewState,
} from '@/lib/services/brand/brandReviewJob';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import { colorDistance } from '@/lib/utils/shared/brand/brandColor';
import { DocumentModel } from '@/lib/utils/shared/documents/documentModel';

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A whole brand review on the job runner, with the document, its pictures
 * and the model faked: text checks, logo matching with distortion and
 * background, the model's page review, and a page the model fails on.
 */

vi.mock('@/config/environment', () => ({ env: {} }));

const LOGO = fs.readFileSync(
  path.join(process.cwd(), '__tests__/fixtures/brand/logo.png'),
);
const SAND = '#f2e8d5';
const PAGE = { width: 600, height: 400 };

let squashed: Buffer;
let unrelated: Buffer;
let sandPage: Buffer;
beforeAll(async () => {
  squashed = await sharp(LOGO)
    .resize(400, 100, { fit: 'fill' })
    .png()
    .toBuffer();
  unrelated = await sharp({
    create: { width: 120, height: 120, channels: 3, background: '#ffffff' },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="120" height="120"><rect x="0" y="60" width="120" height="60" fill="#c00"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  sandPage = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: SAND },
  })
    .png()
    .toBuffer();
});

const book = (() => {
  const parsed = parseBrandBookBody({
    name: 'Northwind',
    palette: [{ name: 'Teal', hex: '#0f7c80' }],
    fonts: [{ role: 'body', family: 'Source Sans Pro' }],
    logos: [
      {
        id: 'main',
        name: 'Main logo',
        file: 'admin:brand-aaaaaaaaaaaa/logo.png',
        allowedColors: ['#ffffff'],
      },
    ],
    language: { banned: [{ term: 'cheap', alternatives: ['affordable'] }] },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.body;
})();

const run = (text: string, font: string) => ({
  text,
  font,
  size: 11,
  color: '#0f7c80',
  bold: false,
  italic: false,
  lang: null,
});

const model: DocumentModel = {
  scheme: 1,
  format: 'pdf',
  pageCount: 2,
  pages: [
    { page: 1, ...PAGE },
    { page: 2, ...PAGE },
  ],
  units: [
    {
      id: 'u1',
      page: 1,
      kind: 'text',
      text: 'Welcome',
      box: [50, 40, 300, 60],
      runs: [run('Welcome', 'Comic Sans MS')],
    },
    {
      id: 'u2',
      page: 2,
      kind: 'text',
      text: 'Never cheap.',
      box: [50, 40, 300, 60],
      runs: [run('Never cheap.', 'Source Sans Pro')],
    },
  ],
  images: [
    {
      id: 'img-logo',
      page: 1,
      box: [100, 100, 300, 200],
      name: null,
      sha256: 'a',
      file: 'logo.png',
      contentType: 'image/png',
    },
    {
      id: 'img-squashed',
      page: 2,
      box: [100, 100, 300, 150],
      name: null,
      sha256: 'b',
      file: 'squashed.png',
      contentType: 'image/png',
    },
    {
      id: 'img-other',
      page: 2,
      box: [400, 100, 460, 160],
      name: null,
      sha256: 'c',
      file: 'other.png',
      contentType: 'image/png',
    },
  ],
  theme: null,
};

function memoryStore(): JobStore & { state: unknown } {
  const store = {
    state: null as unknown,
    getJob: async () => store.state,
    putJob: async (state: unknown) => {
      store.state = state;
    },
    stopRequested: async () => false,
    requestStop: async () => {},
    clearStop: async () => {},
  };
  return store;
}

function memorySlots(): JobSlots {
  let records: JobSlotRecord[] = [];
  return {
    read: async () => [...records],
    write: async (record) => {
      records = [...records.filter((r) => r.key !== record.key), record];
    },
    release: async (key) => {
      records = records.filter((r) => r.key !== key);
    },
  };
}

function deps(): BrandReviewDeps & {
  reviewPage: ReturnType<typeof vi.fn>;
  pagePictures: ReturnType<typeof vi.fn>;
} {
  const files: Record<string, Uint8Array> = {
    'logo.png': LOGO,
    'squashed.png': squashed,
    'other.png': unrelated,
  };
  return {
    readDocument: async () => Buffer.from('%PDF-1.7'),
    readLogo: async () => LOGO,
    inspect: vi.fn(async () => ({
      model,
      imageFile: (file: string) => files[file] ?? null,
    })),
    pagePictures: vi.fn(async ({ pages }: { pages: readonly number[] }) => {
      return new Map(pages.map((page) => [page, sandPage]));
    }),
    reviewPage: vi.fn(async ({ page }: { page: number }) => {
      if (page === 2) throw new Error('model unavailable');
      return [
        {
          id: 'tone:1:u1',
          rule: 'tone' as const,
          severity: 'warning' as const,
          page: 1,
          unitId: 'u1',
          imageId: null,
          box: model.units[0].box,
          found: 'Welcome',
          expected: [],
          source: 'model' as const,
          note: 'Warmer, please.',
        },
      ];
    }),
    model: 'vision-model',
  };
}

let keys = 0;

async function review(request: Partial<BrandReviewRequest>, d = deps()) {
  const key = `review-${(keys += 1)}`;
  await startJob(
    BRAND_REVIEW_JOB_KIND,
    {
      store: memoryStore(),
      slots: memorySlots(),
      key,
      context: { user: { id: 'u1' } as never, deps: d },
    },
    {
      book: {
        id: 'brand-aaaaaaaaaaaa',
        name: 'Northwind',
        updatedAt: 'x',
        body: book,
      },
      file: `/api/file/${'f'.repeat(64)}.pdf`,
      name: 'Annual review.pdf',
      type: 'pdf',
      modelReview: true,
      ...request,
    },
  );
  return {
    final: (await jobInProcess<BrandReviewState>('brand-review', key))!,
    d,
  };
}

describe('brand review job', () => {
  it('reports text, logo and model findings page by page', async () => {
    // The fixture's ground is not white, by more than the tolerance.
    expect(colorDistance(SAND, '#ffffff')).toBeGreaterThan(3);
    const { final, d } = await review({});
    expect(final.status).toBe('done');
    expect(
      final.findings.map((f) => `${f.page}:${f.rule}:${f.unitId ?? f.imageId}`),
    ).toEqual([
      '1:font:u1',
      '1:logo-background:img-logo',
      '1:tone:u1',
      '2:banned-term:u2',
      '2:logo-distorted:img-squashed',
      '2:logo-background:img-squashed',
    ]);
    expect(final.pageCount).toBe(2);
    expect(final.pages).toEqual(model.pages);
    expect(final.reviewedPages).toEqual([1]);
    // The page the model failed on is reported as not looked at.
    expect(final.skippedPages).toEqual([2]);
    // Only the unmatched picture is shown to the model as a possible logo.
    const page2 = d.reviewPage.mock.calls.find(
      ([input]) => input.page === 2,
    )![0];
    expect(page2.pictures.map((p: { id: string }) => p.id)).toEqual([
      'img-other',
    ]);
    expect(page2.units.map((u: { id: string }) => u.id)).toEqual(['u2']);
  });

  it('runs without the model when not asked, still checking logo backgrounds', async () => {
    const { final, d } = await review({ modelReview: false });
    expect(final.status).toBe('done');
    expect(d.reviewPage).not.toHaveBeenCalled();
    expect(final.skippedPages).toEqual([]);
    expect(final.findings.some((f) => f.source === 'model')).toBe(false);
    expect(
      final.findings.filter((f) => f.rule === 'logo-background'),
    ).toHaveLength(2);
    // Pictures only for the pages with a logo whose background matters.
    expect(d.pagePictures.mock.calls.flatMap(([r]) => r.pages)).toEqual([1, 2]);
  });

  it('checks logos without a background when no page picture is needed', async () => {
    const plainBook = {
      ...book,
      logos: book.logos.map((logo) => ({ ...logo, allowedColors: [] })),
    };
    const { final, d } = await review({
      modelReview: false,
      book: {
        id: 'brand-aaaaaaaaaaaa',
        name: 'N',
        updatedAt: 'x',
        body: plainBook,
      },
    });
    expect(d.pagePictures).not.toHaveBeenCalled();
    expect(final.findings.map((f) => f.rule)).toEqual([
      'font',
      'banned-term',
      'logo-distorted',
    ]);
  });
});
