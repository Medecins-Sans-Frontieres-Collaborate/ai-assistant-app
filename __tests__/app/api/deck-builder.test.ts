import { NextRequest } from 'next/server';

import { JobActiveError } from '@/lib/services/backgroundJobs/backgroundJobs';
import { usableBrandBook } from '@/lib/services/brand/brandBooks';
import {
  DeckPlanBlockedError,
  readDeckJob,
  startDeckBuild,
  startDeckOutline,
} from '@/lib/services/deckBuilder/deckBuilds';
import { DeckInputError } from '@/lib/services/deckBuilder/deckInputs';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import { GET } from '@/app/api/deck-builder/[id]/route';
import { POST as BUILD } from '@/app/api/deck-builder/build/route';
import { POST as OUTLINE } from '@/app/api/deck-builder/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Starting deck outlines and builds: the gates in front of the jobs. */

const mockAuth = vi.hoisted(() => vi.fn());

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: vi.fn(),
  workflowDisabledResponse: () => new Response(null, { status: 403 }),
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun: vi.fn(),
}));
vi.mock('@/lib/services/brand/brandBooks', () => ({
  usableBrandBook: vi.fn(),
}));
vi.mock('@/lib/services/deckBuilder/deckBuilds', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startDeckOutline: vi.fn(),
  startDeckBuild: vi.fn(),
  readDeckJob: vi.fn(),
}));

const BOOK = 'brand-aaaaaaaaaaaa';
const OUTLINE_ID = 'outline-aaaaaaaaaaaa';
const TEMPLATE = {
  file: `/api/file/${'a'.repeat(64)}.pptx`,
  name: 'Mine.pptx',
};
const PLAN = {
  slides: [
    {
      layout: 'slideLayout2',
      fills: [{ placeholder: 'title', kind: 'text', text: 'Hello' }],
      notes: '',
    },
  ],
};

const post = (handler: typeof OUTLINE, body: unknown) =>
  handler(
    new NextRequest('https://app.example.com/api/deck-builder', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

describe('POST /api/deck-builder (outline)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    vi.mocked(isWorkflowEnabled).mockResolvedValue(true);
    vi.mocked(beginWorkflowRun).mockResolvedValue({ denied: null } as never);
    vi.mocked(usableBrandBook).mockResolvedValue({ id: BOOK } as never);
    vi.mocked(startDeckOutline).mockResolvedValue({
      outlineId: OUTLINE_ID,
      state: { status: 'running' },
    } as never);
  });

  it('needs a person and the workflow switched on', async () => {
    mockAuth.mockResolvedValue(null);
    expect(
      (await post(OUTLINE, { template: TEMPLATE, brief: 'x' })).status,
    ).toBe(401);
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    vi.mocked(isWorkflowEnabled).mockResolvedValue(false);
    expect(
      (await post(OUTLINE, { template: TEMPLATE, brief: 'x' })).status,
    ).toBe(403);
  });

  it('refuses a malformed request or book, and a book the person may not use', async () => {
    expect((await post(OUTLINE, { brief: 'x' })).status).toBe(400);
    expect(
      (await post(OUTLINE, { template: TEMPLATE, brief: 'x', bookId: 'nope' }))
        .status,
    ).toBe(400);
    vi.mocked(usableBrandBook).mockResolvedValue(null);
    expect(
      (await post(OUTLINE, { template: TEMPLATE, brief: 'x', bookId: BOOK }))
        .status,
    ).toBe(404);
    expect(startDeckOutline).not.toHaveBeenCalled();
  });

  it('starts within budget, in the reader’s language unless one is chosen', async () => {
    const response = await post(OUTLINE, {
      template: TEMPLATE,
      brief: 'Board update',
      language: 'pt-br',
    });
    expect(response.status).toBe(202);
    expect(beginWorkflowRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startDeckOutline).mock.calls[0][1]).toMatchObject({
      template: TEMPLATE,
      book: null,
      brief: 'Board update',
      sources: [],
      pictures: [],
      language: 'pt-BR',
    });
  });

  it('answers 400 with the reason for an input it cannot use, and 409 when busy', async () => {
    vi.mocked(startDeckOutline).mockRejectedValueOnce(
      new DeckInputError('Mine.pdf is not a PNG, JPEG or GIF.'),
    );
    const refused = await post(OUTLINE, { template: TEMPLATE, brief: 'x' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain('Mine.pdf');
    vi.mocked(startDeckOutline).mockRejectedValueOnce(
      new JobActiveError('deck-outline', {
        key: 'outline-bbbbbbbbbbbb',
        label: 'Other deck',
        heartbeatAt: 0,
      }),
    );
    const busy = await post(OUTLINE, { template: TEMPLATE, brief: 'x' });
    expect(busy.status).toBe(409);
    expect(JSON.stringify(await busy.json())).toContain('Other deck');
  });
});

describe('POST /api/deck-builder/build', () => {
  const doneOutline = (book: { id: string } | null = { id: BOOK }) =>
    ({ status: 'done', request: { book } }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    vi.mocked(isWorkflowEnabled).mockResolvedValue(true);
    vi.mocked(beginWorkflowRun).mockResolvedValue({ denied: null } as never);
    vi.mocked(usableBrandBook).mockResolvedValue({ id: BOOK } as never);
    vi.mocked(readDeckJob).mockResolvedValue(doneOutline());
    vi.mocked(startDeckBuild).mockResolvedValue({
      buildId: 'deck-aaaaaaaaaaaa',
      state: { status: 'running' },
    } as never);
  });

  const body = {
    outlineId: OUTLINE_ID,
    plan: PLAN,
    // A character a file name cannot hold becomes one space, not two.
    name: 'Annual: review',
    locale: 'en',
  };

  it('refuses a malformed plan before reading anything', async () => {
    expect(
      (
        await post(BUILD, {
          ...body,
          plan: { slides: [{ layout: '', fills: [] }] },
        })
      ).status,
    ).toBe(400);
    expect((await post(BUILD, { ...body, outlineId: '../x' })).status).toBe(
      400,
    );
    expect(readDeckJob).not.toHaveBeenCalled();
  });

  it('builds only from a finished outline whose book the person may still use', async () => {
    vi.mocked(readDeckJob).mockResolvedValueOnce({
      status: 'running',
    } as never);
    expect((await post(BUILD, body)).status).toBe(404);
    vi.mocked(usableBrandBook).mockResolvedValueOnce(null);
    expect((await post(BUILD, body)).status).toBe(404);
    expect(startDeckBuild).not.toHaveBeenCalled();
  });

  it('starts within budget, with a file name that is safe', async () => {
    const response = await post(BUILD, body);
    expect(response.status).toBe(202);
    expect(vi.mocked(startDeckBuild).mock.calls[0][1]).toEqual({
      outlineId: OUTLINE_ID,
      plan: PLAN,
      name: 'Annual review',
      noteLocale: 'en',
    });
  });

  it('answers 422 with the problems of a plan that cannot be built', async () => {
    vi.mocked(startDeckBuild).mockRejectedValueOnce(
      new DeckPlanBlockedError([
        {
          code: 'too-long',
          slide: 1,
          placeholder: '1',
          message: 'Slide 1: too long.',
        },
      ]),
    );
    const response = await post(BUILD, body);
    expect(response.status).toBe(422);
    expect((await response.json()).details.problems[0].message).toBe(
      'Slide 1: too long.',
    );
  });
});

describe('GET /api/deck-builder/<id>', () => {
  it('404s an id the person has no work under', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    vi.mocked(readDeckJob).mockResolvedValue(null);
    const response = await GET(new NextRequest('https://app.example.com/x'), {
      params: Promise.resolve({ id: 'review-aaaaaaaaaaaa' }),
    });
    expect(response.status).toBe(404);
  });
});
