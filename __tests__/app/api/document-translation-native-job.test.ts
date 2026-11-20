import { NextRequest } from 'next/server';

import {
  STALLED_MS,
  jobInProcess,
} from '@/lib/services/documentTranslation/native/deckRunJob';

import { parseJsonResponse } from './helpers';

import {
  DELETE,
  GET,
  POST,
} from '@/app/api/document-translation/native/job/route';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The presentation job route over run folders in memory: starting returns
 * at once, progress is read, a stalled job is picked up again by a read,
 * one run per person, and a stop.
 */
const mockAuth = vi.hoisted(() => vi.fn());
const translate = vi.hoisted(() => vi.fn());
/** owner/run -> file -> bytes */
const folders = vi.hoisted(() => new Map<string, Map<string, Buffer>>());
const slots = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/workflows/policy/guard', async (original) => ({
  ...(await original<typeof import('@/lib/services/workflows/policy/guard')>()),
  isWorkflowFeatureEnabled: vi.fn(async () => true),
  getWorkflowFeatureLimits: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveWorkflowModelId: vi.fn(() => 'model'),
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun: vi.fn(async () => ({
    denied: null,
    usage: { fields: () => ({}) },
  })),
  WorkflowUsageCollector: class {
    fields() {
      return {};
    }
  },
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfGlossary', () => ({
  resolveRequestGlossary: vi.fn(async () => ({ entries: [] })),
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfPipeline', () => ({
  runNativePdfTranslation: translate,
  rerenderNativePdf: vi.fn(),
}));
vi.mock('@/lib/services/presentationRender/renderService', () => ({
  getRenderService: () => ({
    snapshot: () => ({
      running: 0,
      queued: { interactive: 0, translation: 0 },
    }),
    convert: vi.fn(),
  }),
}));
vi.mock('@/lib/services/documentTranslation/native/deckRunSlot', () => ({
  BlobDeckRunSlot: {
    open: (session: { user: { id: string } }) => ({
      read: async () => slots.get(session.user.id) ?? null,
      write: async (record: unknown) => void slots.set(session.user.id, record),
      release: async (runId: string) => {
        const held = slots.get(session.user.id) as
          | { runId?: string }
          | undefined;
        if (held?.runId === runId) slots.delete(session.user.id);
      },
    }),
  },
}));
vi.mock('@/lib/services/documentTranslation/native/nativeRunBackends', () => {
  const folder = (key: string) => {
    const files = () => folders.get(key) ?? new Map<string, Buffer>();
    return {
      expires: true,
      write: async (name: string, data: Buffer) =>
        void folders.set(key, files().set(name, Buffer.from(data))),
      read: async (name: string) => files().get(name) ?? null,
      list: async () =>
        [...files().keys()].map((name) => ({ name, lastModified: new Date() })),
      remove: async (name: string) => void files().delete(name),
      touch: async () => undefined,
      removeAll: async () => void folders.delete(key),
    };
  };
  return {
    BlobRunFolder: {
      open: (session: { user: { id: string } }, runId: string) =>
        folder(`${session.user.id}/${runId}`),
    },
    DriveRunFolder: {},
  };
});

const FIXTURES = path.join(__dirname, '../../fixtures/pptx');
const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER_RUN = '99999999-2222-4333-8444-555555555555';
const BASE = 'http://localhost/api/document-translation/native/job';

function start(name: string, data: Buffer, runId = RUN, pages = '1-3') {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(data)], name));
  form.set('targetLanguage', 'French');
  form.set('pages', pages);
  form.set('runId', runId);
  form.set('storage', 'app');
  form.set('translateNotes', 'false');
  return POST(new NextRequest(BASE, { method: 'POST', body: form }));
}
const query = (runId = RUN) => `${BASE}?run=${runId}&storage=app`;

/** The pipeline result for some slides. */
function finished(pages: number[]) {
  return {
    steps: [],
    pageCount: 5,
    pages: [],
    units: [],
    issues: [],
    uncheckedPages: [],
    fonts: { sans: 'Calibri', serif: 'Cambria' },
    refitRounds: 0,
    brief: { terms: [] },
    pdf: new Uint8Array([37, ...pages]),
    document: new Uint8Array([80, ...pages]),
    outputs: [],
    unitsFile: new TextEncoder().encode(JSON.stringify(pages)),
  };
}

afterEach(async () => {
  // A job a failed test left running must not reach the next test.
  for (const runId of [RUN, OTHER_RUN]) {
    if (jobInProcess(runId)) {
      await DELETE(new NextRequest(query(runId), { method: 'DELETE' }));
      await jobInProcess(runId);
    }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  folders.clear();
  slots.clear();
  mockAuth.mockResolvedValue({ user: { id: 'u1' } });
});

describe('starting', () => {
  it('answers 202 at once, the deck stored, notes as asked', async () => {
    let release!: () => void;
    translate.mockImplementation(
      (params: { pages: number[] }) =>
        new Promise((resolve) => {
          release = () => resolve(finished(params.pages));
        }),
    );
    const response = await start(
      'rich.pptm',
      fs.readFileSync(path.join(FIXTURES, 'rich.pptm')),
    );
    expect(response.status).toBe(202);
    const { data } = await parseJsonResponse(response);
    expect(data.job).toMatchObject({
      status: 'running',
      sourceName: 'rich.pptm',
      format: 'pptm',
      translateNotes: false,
      parts: 1,
      pageCount: 3,
    });
    expect(data.sourceId).toMatch(/\.pptm$/);
    expect(data.job.request).toBeUndefined();
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    expect(translate.mock.calls[0][0]).toMatchObject({
      format: 'pptm',
      translateNotes: false,
      pages: [1, 2, 3],
    });
    release();
    expect((await jobInProcess(RUN))?.status).toBe('done');
  });

  it('refuses a second presentation while the first runs, naming it', async () => {
    translate.mockImplementation(() => new Promise(() => undefined));
    expect(
      (
        await start(
          'rich.pptx',
          fs.readFileSync(path.join(FIXTURES, 'rich.pptx')),
        )
      ).status,
    ).toBe(202);
    const second = await start(
      'hidden.pptx',
      fs.readFileSync(path.join(FIXTURES, 'hidden.pptx')),
      OTHER_RUN,
    );
    expect(second.status).toBe(409);
    const body = await parseJsonResponse(second);
    expect(body.code).toBe('DECK_RUN_ACTIVE');
    expect(body.error).toContain('"rich.pptx"');
    // The refused run stored nothing.
    expect(folders.has(`u1/${OTHER_RUN}`)).toBe(false);
    await DELETE(new NextRequest(query(), { method: 'DELETE' }));
    await jobInProcess(RUN);
  });

  it('refuses a file that is not a readable presentation before storing it', async () => {
    const response = await start(
      'broken.pptx',
      Buffer.from('not a zip at all'),
    );
    expect(response.status).toBe(422);
    expect(folders.size).toBe(0);
    expect(translate).not.toHaveBeenCalled();
  });

  it('refuses an encrypted deck at upload, saying why, before storing it', async () => {
    // A password-protected .pptx is a compound file, not a zip.
    const encrypted = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
    ]);
    const response = await start('locked.pptx', encrypted);
    expect(response.status).toBe(422);
    const body = await parseJsonResponse(response);
    expect(body.code).toBe('DOCUMENT_PROTECTED');
    expect(body.error).toContain('password protected');
    expect(folders.size).toBe(0);
    expect(translate).not.toHaveBeenCalled();
  });

  it('refuses formats it does not translate', async () => {
    expect((await start('deck.odp', Buffer.from('PK'))).status).toBe(400);
    expect((await start('deck.key', Buffer.from('PK'))).status).toBe(400);
  });

  it('refuses a selection past the last slide', async () => {
    const response = await start(
      'rich.pptx',
      fs.readFileSync(path.join(FIXTURES, 'rich.pptx')),
      RUN,
      '9-10',
    );
    expect(response.status).toBe(400);
  });
});

describe('progress after a restart', () => {
  it('a read picks a stalled job up again from its first unfinished batch', async () => {
    // A job some instance was running when it went away: batch 1 of 2 done.
    translate.mockImplementation(async (params: { pages: number[] }) =>
      finished(params.pages),
    );
    const { NativeRunStore } =
      await import('@/lib/services/documentTranslation/native/nativePdfStorage');
    const { BlobRunFolder } =
      await import('@/lib/services/documentTranslation/native/nativeRunBackends');
    const store = new NativeRunStore(
      { runId: RUN, backend: 'app' },
      (
        BlobRunFolder as unknown as { open: (s: unknown, r: string) => never }
      ).open({ user: { id: 'u1' } }, RUN),
    );
    const source = await store.put(
      fs.readFileSync(path.join(FIXTURES, 'rich.pptx')),
      'pptx',
    );
    await store.putJob({
      version: 1,
      jobId: 'j',
      runId: RUN,
      backend: 'app',
      request: {
        sourceName: 'rich.pptx',
        sourceId: source.id,
        format: 'pptx',
        targetLanguage: 'French',
        depth: 'quick',
        instructions: {},
        refitRounds: 0,
        translateNotes: true,
        modelId: 'model',
        glossaryEntries: [],
        batches: [[1, 2, 3, 4, 5, 6], [7]],
      },
      status: 'running',
      pieces: [
        { pages: [], units: [], styles: {}, sourceId: source.id, unitsId: 'x' },
      ],
      startedAt: 0,
      heartbeatAt: Date.now() - STALLED_MS - 5000,
      resumes: 0,
    });

    const response = await GET(new NextRequest(query()));
    expect(response.status).toBe(200);
    const { data } = await parseJsonResponse(response);
    expect(data.job.resumes).toBe(1);
    expect(data.queue).toBeDefined();
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    expect(translate.mock.calls[0][0].pages).toEqual([7]);
  });

  it('is 404 for a run without a job', async () => {
    expect((await GET(new NextRequest(query()))).status).toBe(404);
  });
});

describe('stopping', () => {
  it('stops the job and keeps what finished', async () => {
    translate.mockImplementation(
      (params: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          params.signal.addEventListener('abort', () =>
            reject(params.signal.reason),
          ),
        ),
    );
    await start('rich.pptx', fs.readFileSync(path.join(FIXTURES, 'rich.pptx')));
    const response = await DELETE(
      new NextRequest(query(), { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    expect((await jobInProcess(RUN))?.status).toBe('stopped');
    expect(slots.size).toBe(0);
  });
});
