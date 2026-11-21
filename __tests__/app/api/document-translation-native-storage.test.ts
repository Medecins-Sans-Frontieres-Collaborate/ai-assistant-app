import { NextRequest } from 'next/server';

import {
  RUN_KEY_HEADER,
  RUN_RECORD_ID,
  RUN_RECORD_MAX_BYTES,
  bytesToBase64,
  deriveRunKey,
  encryptRunFile,
  isEncryptedRunFile,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { parseJsonResponse } from './helpers';

import {
  GET as GET_FILE,
  PUT as PUT_RECORD,
} from '@/app/api/document-translation/native/file/route';
import { POST as RENDER } from '@/app/api/document-translation/native/render/route';
import {
  DELETE as DELETE_RUN,
  POST as SYNC_RUN,
} from '@/app/api/document-translation/native/run/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The routes a translation run's files go through, over a folder in memory:
 * what may be named, who may read what, and what a browser is told when a
 * run is gone or locked.
 */
const mockAuth = vi.hoisted(() => vi.fn());
const featureEnabled = vi.hoisted(() => vi.fn());
const rerender = vi.hoisted(() => vi.fn());
/** user id -> run id -> file name -> bytes */
const drive = vi.hoisted(() => new Map<string, Map<string, Buffer>>());
const driveRefusal = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/policy/guard', async (original) => ({
  ...(await original<typeof import('@/lib/services/workflows/policy/guard')>()),
  isWorkflowFeatureEnabled: featureEnabled,
  getWorkflowFeatureLimits: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfPipeline', () => ({
  NativePdfDocumentLimitError: class extends Error {},
  NativePdfNoPagesLeftError: class extends Error {},
  rerenderNativePdf: rerender,
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveWorkflowModelId: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun: vi.fn(async () => ({
    denied: null,
    usage: { fields: () => ({}) },
  })),
}));
vi.mock('@/lib/services/documentTranslation/native/nativeRunBackends', () => {
  const folder = (owner: string, runId: string, expires: boolean) => {
    const key = `${owner}/${runId}`;
    const files = () => drive.get(key) ?? new Map<string, Buffer>();
    return {
      expires,
      write: async (name: string, data: Buffer) => {
        drive.set(key, files().set(name, data));
      },
      read: async (name: string) => files().get(name) ?? null,
      list: async () =>
        [...files().keys()].map((name) => ({
          name,
          lastModified: new Date(),
        })),
      remove: async (name: string) => void files().delete(name),
      touch: async () => undefined,
      removeAll: async () => void drive.delete(key),
    };
  };
  return {
    BlobRunFolder: {
      open: (session: { user: { id: string } }, runId: string) =>
        folder(session.user.id, runId, true),
    },
    DriveRunFolder: {
      open: async (_req: unknown, runId: string) => {
        if (driveRefusal.error) throw driveRefusal.error;
        return folder('onedrive', runId, false);
      },
    },
  };
});

const RUN = '11111111-2222-4333-8444-555555555555';
const SOURCE = `${'a'.repeat(64)}.pdf`;
const UNITS = `${'b'.repeat(64)}.json`;
const BASE = 'http://localhost/api/document-translation/native';

const fileUrl = (query: Record<string, string>) =>
  `${BASE}/file?${new URLSearchParams(query).toString()}`;
const getFile = (query: Record<string, string>) =>
  GET_FILE(new NextRequest(fileUrl(query)));
const putRecord = (body: Uint8Array, query = { run: RUN, storage: 'app' }) =>
  PUT_RECORD(
    new NextRequest(fileUrl(query), {
      method: 'PUT',
      body: new Uint8Array(body),
    }),
  );
const sync = (body: Record<string, unknown>) =>
  SYNC_RUN(
    new NextRequest(`${BASE}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
const render = (headers: Record<string, string> = {}) =>
  RENDER(
    new NextRequest(`${BASE}/render`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        runId: RUN,
        storage: 'app',
        sourceId: SOURCE,
        unitsId: UNITS,
        translations: {},
      }),
    }),
  );
const seed = (owner: string, files: Record<string, Uint8Array>) =>
  drive.set(
    `${owner}/${RUN}`,
    new Map(
      Object.entries(files).map(([name, data]) => [name, Buffer.from(data)]),
    ),
  );
const text = (value: string) => new TextEncoder().encode(value);

beforeEach(() => {
  vi.clearAllMocks();
  drive.clear();
  driveRefusal.error = null;
  mockAuth.mockResolvedValue({ user: { id: 'u1' } });
  featureEnabled.mockResolvedValue(true);
  rerender.mockResolvedValue({
    pdf: text('%PDF-new'),
    outputs: [],
    unitsFile: text('{}'),
    fits: [],
  });
});

describe('reading a file of a run', () => {
  it('needs a signed-in person', async () => {
    mockAuth.mockResolvedValue(null);
    expect(
      (await getFile({ run: RUN, storage: 'app', id: SOURCE })).status,
    ).toBe(401);
  });

  it('refuses anything that is not a run, a storage or a run file', async () => {
    const bad = [
      { run: '../u2', storage: 'app', id: SOURCE },
      { run: RUN, storage: 'elsewhere', id: SOURCE },
      { run: RUN, storage: 'app', id: `../${SOURCE}` },
      { run: RUN, storage: 'app', id: 'passwords.txt' },
    ];
    for (const query of bad) {
      expect((await getFile(query)).status).toBe(400);
    }
  });

  it('serves the file as stored, with its type', async () => {
    seed('u1', { [SOURCE]: text('%PDF-plain') });
    const response = await getFile({ run: RUN, storage: 'app', id: SOURCE });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('%PDF-plain');
  });

  it("never reaches another person's run", async () => {
    seed('u2', { [SOURCE]: text('%PDF-theirs') });
    const response = await getFile({ run: RUN, storage: 'app', id: SOURCE });
    expect(response.status).toBe(404);
    expect((await parseJsonResponse(response)).code).toBe('RUN_FILES_MISSING');
  });

  it('hands an encrypted file over still encrypted, needing no key', async () => {
    const key = await deriveRunKey(new Uint8Array(32).fill(1), RUN);
    seed('u1', {
      [SOURCE]: await encryptRunFile(key, RUN, SOURCE, text('%PDF-secret')),
    });
    const response = await getFile({ run: RUN, storage: 'app', id: SOURCE });
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(isEncryptedRunFile(body)).toBe(true);
    expect(new TextDecoder().decode(body)).not.toContain('secret');
  });

  it('passes on why OneDrive cannot be used', async () => {
    const { M365Error } = await import('@/lib/services/m365/graphApi');
    driveRefusal.error = new M365Error('Consent', 'consent_missing', 403);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await getFile({
      run: RUN,
      storage: 'onedrive',
      id: SOURCE,
    });
    expect(response.status).toBe(403);
    expect((await parseJsonResponse(response)).code).toBe(
      'M365_CONSENT_MISSING',
    );
    // The answer alone does not say why OneDrive failed; the log does.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('consent_missing (403): Consent'),
    );
    warn.mockRestore();
  });
});

describe('saving the record', () => {
  it('stores what the browser sends, and only as the record', async () => {
    const response = await putRecord(text('{"units":[]}'));
    expect(response.status).toBe(200);
    expect(drive.get(`u1/${RUN}`)?.get(RUN_RECORD_ID)?.toString()).toBe(
      '{"units":[]}',
    );
    expect([...drive.get(`u1/${RUN}`)!.keys()]).toEqual([RUN_RECORD_ID]);
  });

  it('refuses an empty record, one too large, and a switched-off feature', async () => {
    expect((await putRecord(new Uint8Array())).status).toBe(400);
    expect(
      (await putRecord(new Uint8Array(RUN_RECORD_MAX_BYTES + 1))).status,
    ).toBe(413);
    expect((await putRecord(new Uint8Array(RUN_RECORD_MAX_BYTES))).status).toBe(
      200,
    );
    featureEnabled.mockResolvedValue(false);
    expect((await putRecord(text('{}'))).status).toBe(403);
  });
});

describe('keeping a run in step', () => {
  it('deletes what is no longer used and reports the expiry', async () => {
    seed('u1', {
      [SOURCE]: text('a'),
      [UNITS]: text('b'),
      [RUN_RECORD_ID]: text('{}'),
    });
    const response = await sync({ runId: RUN, storage: 'app', keep: [SOURCE] });
    const body = await parseJsonResponse(response);
    expect(body.data.files).toBe(2);
    expect(Date.parse(body.data.expiresAt)).toBeGreaterThan(Date.now());
    expect(drive.get(`u1/${RUN}`)?.has(UNITS)).toBe(false);
  });

  it('has no expiry on OneDrive', async () => {
    seed('onedrive', { [RUN_RECORD_ID]: text('{}') });
    const body = await parseJsonResponse(
      await sync({ runId: RUN, storage: 'onedrive' }),
    );
    expect(body.data.expiresAt).toBeNull();
  });

  it('refuses a keep list that names anything but run files', async () => {
    seed('u1', { [RUN_RECORD_ID]: text('{}') });
    expect(
      (await sync({ runId: RUN, storage: 'app', keep: ['../x'] })).status,
    ).toBe(400);
    expect(
      (await sync({ runId: RUN, storage: 'app', keep: 'all' })).status,
    ).toBe(400);
  });

  it('says so when the run is gone', async () => {
    const response = await sync({ runId: RUN, storage: 'app' });
    expect(response.status).toBe(404);
    expect((await parseJsonResponse(response)).code).toBe('RUN_FILES_MISSING');
  });

  it('deletes a run, and a run already gone', async () => {
    seed('u1', { [RUN_RECORD_ID]: text('{}') });
    const request = () =>
      DELETE_RUN(
        new NextRequest(`${BASE}/run?run=${RUN}&storage=app`, {
          method: 'DELETE',
        }),
      );
    expect((await request()).status).toBe(200);
    expect(drive.has(`u1/${RUN}`)).toBe(false);
    expect((await request()).status).toBe(200);
  });
});

describe('laying out a stored run again', () => {
  it('tells the browser when the files have expired', async () => {
    const response = await render();
    expect(response.status).toBe(404);
    expect((await parseJsonResponse(response)).code).toBe('RUN_FILES_MISSING');
    expect(rerender).not.toHaveBeenCalled();
  });

  it('reads an encrypted run only with its key, and writes it back encrypted', async () => {
    const key = await deriveRunKey(new Uint8Array(32).fill(1), RUN);
    seed('u1', {
      [SOURCE]: await encryptRunFile(key, RUN, SOURCE, text('%PDF-secret')),
      [UNITS]: await encryptRunFile(key, RUN, UNITS, text('{"units":[]}')),
    });

    const locked = await render();
    expect(locked.status).toBe(400);
    expect((await parseJsonResponse(locked)).code).toBe('RUN_LOCKED');

    const other = await deriveRunKey(new Uint8Array(32).fill(2), RUN);
    const mismatch = await render({ [RUN_KEY_HEADER]: bytesToBase64(other) });
    expect((await parseJsonResponse(mismatch)).code).toBe('RUN_KEY_MISMATCH');
    expect(rerender).not.toHaveBeenCalled();

    const opened = await render({ [RUN_KEY_HEADER]: bytesToBase64(key) });
    expect(opened.status).toBe(200);
    // The pipeline was given the readable source...
    expect(rerender.mock.calls[0][0].document.toString()).toBe('%PDF-secret');
    // ...and nothing readable was written back.
    for (const [name, data] of drive.get(`u1/${RUN}`)!) {
      expect(isEncryptedRunFile(data), name).toBe(true);
    }
    expect(drive.get(`u1/${RUN}`)!.size).toBe(3);
  });

  it('refuses a key of the wrong size', async () => {
    const response = await render({ [RUN_KEY_HEADER]: 'c2hvcnQ=' });
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).error).toMatch(/run key/);
  });
});

describe('presentation runs', () => {
  const DECK = `${'c'.repeat(64)}.pptm`;

  it.each([
    [
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    ['pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
    [
      'ppsx',
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    ],
    [
      'potx',
      'application/vnd.openxmlformats-officedocument.presentationml.template',
    ],
  ])('serves a stored .%s with its type', async (kind, type) => {
    const id = `${'d'.repeat(64)}.${kind}`;
    seed('u1', { [id]: text('PK-deck') });
    const response = await getFile({ run: RUN, storage: 'app', id });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
  });

  it('never serves the job state or a stop request', async () => {
    seed('u1', { 'job.json': text('{}'), 'stop.json': text('{}') });
    for (const id of ['job.json', 'stop.json']) {
      expect((await getFile({ run: RUN, storage: 'app', id })).status).toBe(
        400,
      );
    }
  });

  it('keeps the job state and a stop request when the browser syncs', async () => {
    seed('u1', {
      [SOURCE]: text('%PDF-plain'),
      'job.json': text('{}'),
      'stop.json': text('{}'),
      [`${'e'.repeat(64)}.png`]: text('old'),
    });
    const response = await sync({ runId: RUN, storage: 'app', keep: [SOURCE] });
    expect(response.status).toBe(200);
    expect([...drive.get(`u1/${RUN}`)!.keys()].sort()).toEqual(
      [SOURCE, 'job.json', 'stop.json'].sort(),
    );
  });

  it('re-renders a deck run as a deck: its format passed on, its deck stored', async () => {
    seed('u1', { [DECK]: text('PK-deck'), [UNITS]: text('{}') });
    rerender.mockResolvedValue({
      pdf: text('%PDF-new'),
      document: text('PK-translated'),
      outputs: [],
      unitsFile: text('{}'),
      fits: [],
    });
    const response = await RENDER(
      new NextRequest(`${BASE}/render`, {
        method: 'POST',
        body: JSON.stringify({
          runId: RUN,
          storage: 'app',
          sourceId: DECK,
          unitsId: UNITS,
          translations: {},
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(rerender).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'pptm' }),
    );
    const { data } = await parseJsonResponse(response);
    expect(data.documentUrl).toMatch(/\.pptm/);
  });

  it('refuses a source id of a kind no adapter reads', async () => {
    const response = await RENDER(
      new NextRequest(`${BASE}/render`, {
        method: 'POST',
        body: JSON.stringify({
          runId: RUN,
          storage: 'app',
          sourceId: `${'a'.repeat(64)}.png`,
          unitsId: UNITS,
          translations: {},
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});
