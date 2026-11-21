import {
  ABANDONED_MS,
  DeckJobRequest,
  DeckJobState,
  DeckRunActiveError,
  DeckRunSlot,
  DeckRunSlotRecord,
  STALLED_MS,
  claimSlot,
  isStalled,
  jobInProcess,
  readDeckJob,
  resumeDeckJob,
  startDeckJob,
  stopDeckJob,
} from '@/lib/services/documentTranslation/native/deckRunJob';
import type { NativePdfResult } from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import { NativeRunStore } from '@/lib/services/documentTranslation/native/nativePdfStorage';
import type { RunFolder } from '@/lib/services/documentTranslation/native/nativeRunBackends';
import { DocumentRefusedError } from '@/lib/services/documents/model/inspect';

import { describe, expect, it, vi } from 'vitest';

/**
 * THE JOB CONVENTION (deckRunJob.ts): a presentation run in the background,
 * its state in the run's folder, picked up again after a restart without
 * repeating finished batches, one per person, stoppable from any instance.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/observability/tokenUsageRecorder', () => ({
  recordTokenUsage: vi.fn(),
}));
vi.mock('@/lib/services/documentTranslation/native/nativeRunBackends', () => ({
  BlobRunFolder: {},
  DriveRunFolder: {},
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfPipeline', () => ({
  runNativePdfTranslation: vi.fn(),
  rerenderNativePdf: vi.fn(),
}));

/** A run folder in memory. */
function memoryFolder(): RunFolder & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    expires: true,
    write: async (name, data) => void files.set(name, Buffer.from(data)),
    read: async (name) => files.get(name) ?? null,
    list: async () => [...files.keys()].map((name) => ({ name })),
    remove: async (name) => void files.delete(name),
    touch: async () => undefined,
    removeAll: async () => files.clear(),
  };
}

const RUN = '11111111-2222-3333-4444-555555555555';

function storeWith(folder = memoryFolder()) {
  return {
    folder,
    store: new NativeRunStore({ runId: RUN, backend: 'app' }, folder),
  };
}

function memorySlot(initial: DeckRunSlotRecord | null = null): DeckRunSlot & {
  record: DeckRunSlotRecord | null;
} {
  const slot = {
    record: initial,
    read: async () => slot.record,
    write: async (record: DeckRunSlotRecord) => {
      slot.record = record;
    },
    release: async (runId: string) => {
      if (slot.record?.runId === runId) slot.record = null;
    },
  };
  return slot;
}

const user = { id: 'user-1' } as never;

function request(batches: number[][]): Omit<DeckJobRequest, 'sourceId'> {
  return {
    sourceName: 'Annual report.pptx',
    format: 'pptx',
    targetLanguage: 'French',
    depth: 'quick',
    instructions: {},
    refitRounds: 1,
    translateNotes: true,
    modelId: 'model',
    glossaryEntries: [],
    batches,
  };
}

/** What the pipeline returns for a batch of slides. */
function result(pages: number[]): NativePdfResult {
  return {
    steps: [],
    pageCount: 8,
    pages: pages.map((page) => ({
      page,
      width: 720,
      height: 540,
      units: 1,
      textChars: 4,
      scanned: false,
    })),
    units: pages.map((page) => ({
      id: `u${page}`,
      page,
      n: 1,
      role: 'body',
      note: '',
      source: `slide ${page}`,
      bbox: [0, 0, 1, 1],
      room: [0, 0, 1, 1],
      budgetChars: 10,
      size: 18,
      translation: `diapo ${page}`,
      scale: 1,
      fits: true,
      tagsRepaired: false,
      refitted: false,
    })),
    issues: [],
    uncheckedPages: [],
    fonts: { sans: 'Calibri', serif: 'Cambria' },
    refitRounds: 0,
    styles: {},
    brief: { terms: [], language: { code: 'fr' } } as never,
    pdf: new Uint8Array([37, 80, 68, 70, ...pages]),
    document: new Uint8Array([80, 75, ...pages]),
    outputs: [],
    unitsFile: new TextEncoder().encode(JSON.stringify({ pages, units: [] })),
  };
}

/** A pipeline whose batches finish when the test says. */
function controlledPipeline() {
  const calls: number[][] = [];
  const pending: Array<{
    pages: number[];
    finish: () => void;
    fail: (e: Error) => void;
  }> = [];
  const translate = vi.fn(
    (params: {
      pages: number[];
      signal?: AbortSignal;
      onStep?: (e: never) => void;
      onQueue?: (n: number) => void;
    }) =>
      new Promise<NativePdfResult>((resolve, reject) => {
        calls.push(params.pages);
        params.onQueue?.(2);
        params.onStep?.({ id: 'extract', status: 'active' } as never);
        params.signal?.addEventListener('abort', () =>
          reject(params.signal?.reason),
        );
        pending.push({
          pages: params.pages,
          finish: () => resolve(result(params.pages)),
          fail: reject,
        });
      }),
  );
  const rerender = vi.fn(async () => ({
    fits: [],
    issues: [],
    checkedPages: [],
    uncheckedPages: [],
    fonts: { sans: 'Calibri', serif: 'Cambria' },
    repaired: [],
    tooLong: [],
    pdf: new Uint8Array([1]),
    document: new Uint8Array([2]),
    exports: {},
    outputs: [],
    unitsFile: new Uint8Array([3]),
  }));
  return { calls, pending, translate, rerender };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i += 1) await flush();
  expect(check()).toBe(true);
}

async function sourceIn(store: NativeRunStore) {
  return (await store.put(new Uint8Array([80, 75, 3, 4]), 'pptx')).id;
}

describe('startDeckJob', () => {
  it('answers at once, then runs every batch in order and joins them', async () => {
    const { store } = storeWith();
    const slot = memorySlot();
    const pipeline = controlledPipeline();
    const sourceId = await sourceIn(store);
    const state = await startDeckJob({
      store,
      slot,
      user,
      request: { ...request([[1, 2], [3]]), sourceId },
      deps: {
        translate: pipeline.translate as never,
        rerender: pipeline.rerender as never,
        heartbeatMs: 10_000,
      },
    });
    // Started, nothing finished, the person's slot taken.
    expect(state).toMatchObject({ status: 'running', pieces: [] });
    expect(slot.record).toMatchObject({
      runId: RUN,
      sourceName: 'Annual report.pptx',
    });

    await until(() => pipeline.pending.length === 1);
    // Progress is readable while it runs: the step and the queue place.
    await until(() => true);
    const midway = await readDeckJob(store);
    expect(midway?.current?.part).toBe(1);
    pipeline.pending[0].finish();
    await until(() => pipeline.pending.length === 2);
    expect((await readDeckJob(store))?.pieces).toHaveLength(1);
    pipeline.pending[1].finish();

    const final = await jobInProcess(RUN)!;
    expect(pipeline.calls).toEqual([[1, 2], [3]]);
    expect(pipeline.rerender).toHaveBeenCalledTimes(1);
    expect(final.status).toBe('done');
    expect(final.pieces.map((piece) => piece.pages.map((p) => p.page))).toEqual(
      [[1, 2], [3]],
    );
    expect(final.pieces[0]).toMatchObject({ format: 'pptx', sourceId });
    expect(final.pieces[0].documentUrl).toContain('.pptx');
    expect(final.assembled?.documentUrl).toBeDefined();
    expect(await readDeckJob(store)).toMatchObject({ status: 'done' });
    expect(slot.record).toBeNull();
  });

  it('records a failure with its reason and frees the slot', async () => {
    const { store } = storeWith();
    const slot = memorySlot();
    const pipeline = controlledPipeline();
    await startDeckJob({
      store,
      slot,
      user,
      request: { ...request([[1]]), sourceId: await sourceIn(store) },
      deps: {
        translate: pipeline.translate as never,
        rerender: pipeline.rerender as never,
      },
    });
    await until(() => pipeline.pending.length === 1);
    pipeline.pending[0].fail(
      new Error('The sandbox did not run the extract script'),
    );
    const final = await jobInProcess(RUN)!;
    expect(final).toMatchObject({
      status: 'failed',
      error: 'The sandbox did not run the extract script',
    });
    expect(slot.record).toBeNull();
  });
});

describe('one active run per person', () => {
  const held: DeckRunSlotRecord = {
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    backend: 'app',
    sourceName: 'Budget.pptx',
    heartbeatAt: 1_000_000,
  };
  const mine = { ...held, runId: RUN, sourceName: 'Annual report.pptx' };

  it('refuses a second run, naming the first', async () => {
    const error = await claimSlot(
      memorySlot(held),
      mine,
      held.heartbeatAt + 1000,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DeckRunActiveError);
    expect((error as Error).message).toContain('"Budget.pptx"');
  });

  it('frees the slot of a run not heard from for ABANDONED_MS', async () => {
    const slot = memorySlot(held);
    await claimSlot(slot, mine, held.heartbeatAt + ABANDONED_MS + 1);
    expect(slot.record?.runId).toBe(RUN);
  });

  it('lets the slot’s own run claim it again', async () => {
    const slot = memorySlot({ ...held, runId: RUN });
    await expect(
      claimSlot(slot, mine, held.heartbeatAt + 1),
    ).resolves.toBeUndefined();
  });

  it('refuses through startDeckJob before anything is stored', async () => {
    const { store, folder } = storeWith();
    const error = await startDeckJob({
      store,
      slot: memorySlot({ ...held, heartbeatAt: Date.now() }),
      user,
      request: { ...request([[1]]), sourceId: 'x' },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DeckRunActiveError);
    expect(folder.files.size).toBe(0);
  });
});

describe('a restart', () => {
  async function stalledState(
    store: NativeRunStore,
    sourceId: string,
  ): Promise<DeckJobState> {
    const { pdf, outputs, unitsFile, document, ...report } = result([1, 2]);
    const stored = await store.putRebuild({
      pdf,
      outputs,
      document: { data: document!, format: 'pptx' },
    });
    const units = await store.put(unitsFile, 'json');
    const state: DeckJobState = {
      version: 1,
      jobId: 'job',
      runId: RUN,
      backend: 'app',
      request: { ...request([[1, 2], [3]]), sourceId },
      status: 'running',
      pieces: [{ ...report, ...stored, sourceId, unitsId: units.id }],
      current: { part: 2, steps: [] },
      startedAt: 0,
      heartbeatAt: Date.now() - STALLED_MS - 1000,
      resumes: 0,
    };
    await store.putJob(state);
    return state;
  }

  it('is seen as stalled only when its heartbeat is old and no one here runs it', () => {
    const now = 10_000_000;
    expect(
      isStalled(
        { status: 'running', heartbeatAt: now - STALLED_MS - 1, runId: 'x' },
        now,
      ),
    ).toBe(true);
    expect(
      isStalled(
        { status: 'running', heartbeatAt: now - 1000, runId: 'x' },
        now,
      ),
    ).toBe(false);
    expect(isStalled({ status: 'done', heartbeatAt: 0, runId: 'x' }, now)).toBe(
      false,
    );
  });

  it('continues from the first unfinished batch without translating finished ones again', async () => {
    const { store } = storeWith();
    const slot = memorySlot();
    const pipeline = controlledPipeline();
    const sourceId = await sourceIn(store);
    const state = await stalledState(store, sourceId);

    const resumed = await resumeDeckJob({
      store,
      slot,
      user,
      state,
      deps: {
        translate: pipeline.translate as never,
        rerender: pipeline.rerender as never,
      },
    });
    expect(resumed.resumes).toBe(1);
    await until(() => pipeline.pending.length === 1);
    pipeline.pending[0].finish();
    const final = await jobInProcess(RUN)!;
    // Only batch 2 ran: batch 1 was neither translated nor charged again.
    expect(pipeline.calls).toEqual([[3]]);
    expect(final.status).toBe('done');
    expect(final.pieces).toHaveLength(2);
  });

  it('leaves a job with a fresh heartbeat alone', async () => {
    const { store } = storeWith();
    const pipeline = controlledPipeline();
    const state = {
      ...(await stalledState(store, await sourceIn(store))),
      heartbeatAt: Date.now(),
    };
    const same = await resumeDeckJob({
      store,
      slot: memorySlot(),
      user,
      state,
      deps: { translate: pipeline.translate as never },
    });
    expect(same).toBe(state);
    expect(pipeline.translate).not.toHaveBeenCalled();
  });
});

describe('stopping', () => {
  it('stops a job running here at once and keeps finished batches', async () => {
    const { store } = storeWith();
    const pipeline = controlledPipeline();
    const state = await startDeckJob({
      store,
      slot: memorySlot(),
      user,
      request: { ...request([[1], [2]]), sourceId: await sourceIn(store) },
      deps: {
        translate: pipeline.translate as never,
        rerender: pipeline.rerender as never,
      },
    });
    await until(() => pipeline.pending.length === 1);
    pipeline.pending[0].finish();
    await until(() => pipeline.pending.length === 2);
    await stopDeckJob(store, (await readDeckJob(store)) ?? state);
    const final = await jobInProcess(RUN)!;
    expect(final.status).toBe('stopped');
    expect(final.pieces).toHaveLength(1);
    expect(final.error).toBeUndefined();
  });

  it('stops a job run by another instance at its next heartbeat', async () => {
    const { store } = storeWith();
    const pipeline = controlledPipeline();
    await startDeckJob({
      store,
      slot: memorySlot(),
      user,
      request: { ...request([[1]]), sourceId: await sourceIn(store) },
      deps: { translate: pipeline.translate as never, heartbeatMs: 5 },
    });
    await until(() => pipeline.pending.length === 1);
    // What another instance's DELETE writes: the stop marker only.
    await store.requestStop();
    const final = await jobInProcess(RUN)!;
    expect(final.status).toBe('stopped');
  });

  it('a new job is not stopped by an old stop request', async () => {
    const { store } = storeWith();
    await store.requestStop();
    const pipeline = controlledPipeline();
    await startDeckJob({
      store,
      slot: memorySlot(),
      user,
      request: { ...request([[1]]), sourceId: await sourceIn(store) },
      deps: { translate: pipeline.translate as never, heartbeatMs: 5 },
    });
    await until(() => pipeline.pending.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    pipeline.pending[0].finish();
    expect((await jobInProcess(RUN)!).status).toBe('done');
  });
});

describe('a damaged deck', () => {
  it('is repaired once and the batch tried again with the repaired deck', async () => {
    const { store } = storeWith();
    const repaired = Buffer.from('PK repaired deck');
    const repair = vi.fn(async () => repaired);
    const seen: string[] = [];
    const translate = vi.fn(
      async (params: { document: Buffer; pages: number[] }) => {
        seen.push(params.document.toString());
        if (seen.length === 1)
          throw new DocumentRefusedError(
            'DAMAGED',
            'Part ppt/slides/slide2.xml is not well formed',
          );
        return result(params.pages);
      },
    );
    await startDeckJob({
      store,
      slot: memorySlot(),
      user,
      request: { ...request([[1]]), sourceId: await sourceIn(store) },
      deps: { translate: translate as never, repair: repair as never },
    });
    const final = await jobInProcess(RUN)!;
    expect(final.status).toBe('done');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(seen[1]).toBe('PK repaired deck');
    // The repaired copy is the run's source from now on, as a .pptx.
    expect(final.request).toMatchObject({ format: 'pptx', repaired: true });
    expect(final.request.sourceId).toMatch(/\.pptx$/);
    expect(final.pieces[0].sourceId).toBe(final.request.sourceId);
    expect(
      Buffer.from(await store.get(final.request.sourceId)).toString(),
    ).toBe('PK repaired deck');
  });

  it('fails when the repaired deck is refused too, without repairing again', async () => {
    const { store } = storeWith();
    const repair = vi.fn(async () => Buffer.from('PK still bad'));
    const translate = vi.fn(async () => {
      throw new DocumentRefusedError('DAMAGED', 'not well formed');
    });
    await startDeckJob({
      store,
      slot: memorySlot(),
      user,
      request: { ...request([[1]]), sourceId: await sourceIn(store) },
      deps: { translate: translate as never, repair: repair as never },
    });
    const final = await jobInProcess(RUN)!;
    expect(final).toMatchObject({ status: 'failed', error: 'not well formed' });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('is never repaired for another refusal (an encrypted deck)', async () => {
    const { store } = storeWith();
    const repair = vi.fn();
    await startDeckJob({
      store,
      slot: memorySlot(),
      user,
      request: { ...request([[1]]), sourceId: await sourceIn(store) },
      deps: {
        translate: (async () => {
          throw new DocumentRefusedError('ENCRYPTED', 'protected');
        }) as never,
        repair,
      },
    });
    expect((await jobInProcess(RUN)!).status).toBe('failed');
    expect(repair).not.toHaveBeenCalled();
  });
});
