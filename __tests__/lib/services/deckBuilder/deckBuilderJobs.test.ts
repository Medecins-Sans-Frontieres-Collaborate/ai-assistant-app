import {
  JobActiveError,
  JobSlotRecord,
  JobSlots,
  JobStore,
  jobInProcess,
  startJob,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import type { BrandReviewState } from '@/lib/services/brand/brandReviewJob';
import {
  DECK_BUILD_JOB_KIND,
  DECK_OUTLINE_JOB_KIND,
  DeckBuildDeps,
  DeckBuildRequest,
  DeckBuildState,
  DeckOutlineDeps,
  DeckOutlineRequest,
  DeckOutlineState,
} from '@/lib/services/deckBuilder/deckBuilderJobs';
import { DocumentRefusedError } from '@/lib/services/documents/model/inspect';

import type {
  DeckLayouts,
  DeckPlan,
} from '@/lib/utils/shared/documents/deckPlan';

import { describe, expect, it, vi } from 'vitest';

/**
 * The deck builder's jobs, run by the job runner with what they need from
 * the world replaced: what each step reads, makes and keeps.
 */

vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  WorkflowUsageCollector: class {
    fields() {
      return {};
    }
  },
}));

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
      records = [...records.filter((held) => held.key !== record.key), record];
    },
    release: async (key) => {
      records = records.filter((held) => held.key !== key);
    },
  };
}

let keys = 0;
const nextKey = () => `deck-job-${(keys += 1)}`;

const LAYOUTS: DeckLayouts = {
  slideSize: { width: 720, height: 540 },
  slideCount: 1,
  layouts: [],
};
const PLAN: DeckPlan = {
  slides: [
    {
      layout: 'slideLayout1',
      fills: [
        { placeholder: 'ctrTitle', kind: 'text', text: 'Annual review' },
        { placeholder: '1', kind: 'image', image: 'logo:main', alt: 'Logo' },
      ],
      notes: '',
    },
    {
      layout: 'slideLayout2',
      fills: [{ placeholder: 'title', kind: 'text', text: 'What we did' }],
      notes: '',
    },
  ],
};
const BOOK = {
  id: 'brand-aaaaaaaaaaaa',
  name: 'Northwind',
  updatedAt: 'x',
  body: {} as never,
};
const PICTURES = [
  {
    key: 'logo:main',
    name: 'Main logo',
    kind: 'logo' as const,
    file: 'admin:x',
  },
  {
    key: 'picture:1',
    name: 'Unused',
    kind: 'picture' as const,
    file: '/api/file/y',
  },
];

async function outline(
  deps: Partial<DeckOutlineDeps> = {},
  request: Partial<DeckOutlineRequest> = {},
) {
  const key = nextKey();
  const full: DeckOutlineDeps = {
    readTemplate: vi.fn(async () => Buffer.from('template')),
    readSource: vi.fn(async (source) => {
      if (source.name === 'broken.pdf')
        throw new Error('broken.pdf holds no text.');
      return `text of ${source.name}`;
    }),
    readLayouts: vi.fn(async () => LAYOUTS),
    plan: vi.fn(async () => ({
      plan: PLAN,
      repaired: [],
      blocking: [],
      shrunk: [],
    })),
    model: 'model-x',
    ...deps,
  };
  await startJob(
    DECK_OUTLINE_JOB_KIND,
    {
      store: memoryStore(),
      slots: memorySlots(),
      key,
      context: { user: { id: 'u1' } as never, deps: full },
    },
    {
      template: { file: 'admin:t', name: 'Deck', type: 'potx' },
      book: BOOK,
      brief: 'Board update',
      sources: [
        { file: '/api/file/a', name: 'notes.docx' },
        { file: '/api/file/b', name: 'broken.pdf' },
      ],
      pictures: PICTURES,
      language: 'fr',
      ...request,
    },
  );
  const final = await jobInProcess<DeckOutlineState>('deck-outline', key);
  return { final: final!, deps: full };
}

async function build(
  deps: Partial<DeckBuildDeps> = {},
  request: Partial<DeckBuildRequest> = {},
) {
  const key = nextKey();
  const reviews: Array<BrandReviewState['status']> = ['running', 'done'];
  const full: DeckBuildDeps = {
    readTemplate: vi.fn(async () => Buffer.from('template')),
    readPicture: vi.fn(async () => new Uint8Array([1, 2, 3])),
    compose: vi.fn(async () => ({
      deck: new Uint8Array([9]),
      report: { slides: [], units: [] },
    })),
    renderedPages: vi.fn(async () => 2),
    store: vi.fn(async () => '/api/file/deck.pptx'),
    startReview: vi.fn(async () => 'review-cccccccccccc'),
    readReview: vi.fn(
      async () =>
        ({
          status: reviews.shift() ?? 'done',
          findings: [
            { severity: 'error' },
            { severity: 'warning' },
            { severity: 'warning' },
          ],
        }) as unknown as BrandReviewState,
    ),
    pause: vi.fn(async () => {}),
    ...deps,
  };
  await startJob(
    DECK_BUILD_JOB_KIND,
    {
      store: memoryStore(),
      slots: memorySlots(),
      key,
      context: { user: { id: 'u1' } as never, deps: full },
    },
    {
      outlineId: 'outline-aaaaaaaaaaaa',
      template: { file: 'admin:t', name: 'Deck', type: 'potx' },
      book: BOOK,
      plan: PLAN,
      pictures: PICTURES,
      language: 'fr',
      name: 'Annual review',
      noteLocale: 'en',
      ...request,
    },
  );
  const final = await jobInProcess<DeckBuildState>('deck-build', key);
  return { final: final!, deps: full };
}

describe('the outline job', () => {
  it('reads the layouts and sources, and plans from them', async () => {
    const { final, deps } = await outline();
    expect(final.status).toBe('done');
    expect(final.layouts).toBe(LAYOUTS);
    expect(final.plan).toEqual(PLAN);
    expect(deps.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: 'Board update',
        sources: [{ name: 'notes.docx', text: 'text of notes.docx' }],
        layouts: LAYOUTS,
        pictures: PICTURES,
        book: BOOK.body,
        language: 'fr',
        model: 'model-x',
      }),
    );
  });

  it('plans without a source it cannot read, and says so', async () => {
    const { final } = await outline();
    expect(final.unread).toEqual([
      { name: 'broken.pdf', reason: 'broken.pdf holds no text.' },
    ]);
  });

  it('keeps what blocks the plan, for the person to resolve', async () => {
    const blocking = [
      {
        code: 'too-long' as const,
        slide: 2,
        placeholder: '1',
        message: 'Too long.',
      },
    ];
    const { final } = await outline({
      plan: vi.fn(async () => ({
        plan: PLAN,
        repaired: [],
        blocking,
        shrunk: [],
      })),
    });
    expect(final.status).toBe('done');
    expect(final.blocking).toEqual(blocking);
  });
});

describe('the build job', () => {
  it('composes with only the pictures used, renders, keeps the deck, and waits for its review', async () => {
    const { final, deps } = await build();
    expect(final.status).toBe('done');
    expect(deps.readPicture).toHaveBeenCalledTimes(1);
    const [, plan, pictures, options] = vi.mocked(deps.compose).mock.calls[0];
    expect(plan).toBe(PLAN);
    expect([...pictures.keys()]).toEqual(['logo:main']);
    expect(options).toEqual({ language: 'fr' });
    expect(final.file).toBe('/api/file/deck.pptx');
    expect(final.reviewId).toBe('review-cccccccccccc');
    // It read the review until it ended, pausing between reads.
    expect(deps.readReview).toHaveBeenCalledTimes(2);
    expect(deps.pause).toHaveBeenCalledTimes(1);
    expect(final.review).toEqual({ error: 1, warning: 2, info: 0 });
    expect(final.reviewGap).toBeNull();
  });

  it('offers a deck with no review when there is no book', async () => {
    const { final, deps } = await build({}, { book: null });
    expect(final.status).toBe('done');
    expect(final.file).toBe('/api/file/deck.pptx');
    expect(deps.startReview).not.toHaveBeenCalled();
    expect(final.review).toBeNull();
  });

  it('says why a deck has no review: busy, or the review failed', async () => {
    const busy = await build({
      startReview: vi.fn(async () => {
        throw new JobActiveError('brand-review', {
          key: 'review-x',
          label: 'Other',
          heartbeatAt: 0,
        });
      }),
    });
    expect(busy.final.status).toBe('done');
    expect(busy.final.reviewGap).toBe('busy');
    const failed = await build({
      readReview: vi.fn(async () => ({ status: 'failed' }) as BrandReviewState),
    });
    expect(failed.final.reviewGap).toBe('failed');
  });

  it('fails, keeping nothing, when the deck does not render as planned', async () => {
    const { final, deps } = await build({
      renderedPages: vi.fn(async () => 1),
    });
    expect(final.status).toBe('failed');
    expect(final.error).toContain('rendered 1 pages for 2 planned slides');
    expect(deps.store).not.toHaveBeenCalled();
    expect(final.file).toBeNull();
  });

  it('fails with the engine’s reason when it refuses the plan', async () => {
    const { final } = await build({
      compose: vi.fn(async () => {
        throw new DocumentRefusedError(
          'BAD_PLAN',
          'Slide 3 names a layout the template does not have: slideLayout99.',
        );
      }),
    });
    expect(final.status).toBe('failed');
    expect(final.error).toContain('slideLayout99');
  });

  it('fails when a picture the plan places is gone', async () => {
    const { final } = await build({ readPicture: vi.fn(async () => null) });
    expect(final.status).toBe('failed');
    expect(final.error).toContain('Main logo');
  });
});
