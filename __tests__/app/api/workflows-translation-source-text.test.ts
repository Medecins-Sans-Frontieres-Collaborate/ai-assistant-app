import { NextRequest } from 'next/server';

import { RUN_RECORD_ID } from '@/lib/utils/shared/translation/nativeRunStorage';
import { STORED_SOURCE_TEXT_MAX_BYTES } from '@/lib/utils/shared/translation/storedSourceText';

import { parseJsonResponse } from './helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/workflows/translation/source-text/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The route a large source text is stored through, over folders in memory.
 */
const mockAuth = vi.hoisted(() => vi.fn());
const workflowEnabled = vi.hoisted(() => vi.fn());
/** `<kind>/<owner>/<id>` -> file name -> bytes */
const drive = vi.hoisted(() => new Map<string, Map<string, Buffer>>());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/policy/guard', async (original) => ({
  ...(await original<typeof import('@/lib/services/workflows/policy/guard')>()),
  isWorkflowEnabled: workflowEnabled,
}));
vi.mock('@/lib/services/documentTranslation/native/nativeRunBackends', () => {
  const folder = (key: string, expires: boolean) => {
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
      open: (session: { user: { id: string } }, id: string, kind: string) =>
        folder(`${kind}/${session.user.id}/${id}`, true),
    },
    DriveRunFolder: {
      open: async (_req: unknown, id: string, kind: string) =>
        folder(`${kind}/onedrive/${id}`, false),
    },
  };
});

const ID = '11111111-2222-4333-8444-555555555555';
const url = (query: Record<string, string> = { id: ID, storage: 'app' }) =>
  `http://localhost/api/workflows/translation/source-text?${new URLSearchParams(query).toString()}`;
const put = (body: Uint8Array, query?: Record<string, string>) =>
  PUT(
    new NextRequest(url(query), { method: 'PUT', body: new Uint8Array(body) }),
  );
const text = (value: string) => new TextEncoder().encode(value);

beforeEach(() => {
  vi.clearAllMocks();
  drive.clear();
  mockAuth.mockResolvedValue({ user: { id: 'u1' } });
  workflowEnabled.mockResolvedValue(true);
});

describe('a stored source text', () => {
  it('is stored as sent, apart from formatted runs, and read back', async () => {
    const response = await put(text('Le rapport annuel'));
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(Date.parse(body.data.expiresAt)).toBeGreaterThan(Date.now());
    expect([...drive.keys()]).toEqual([`texts/u1/${ID}`]);
    expect(drive.get(`texts/u1/${ID}`)?.get(RUN_RECORD_ID)?.toString()).toBe(
      'Le rapport annuel',
    );
    const read = await GET(new NextRequest(url()));
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('Le rapport annuel');
    expect(read.headers.get('cache-control')).toBe('no-store');
  });

  it('has no expiry on OneDrive', async () => {
    const response = await put(text('x'), { id: ID, storage: 'onedrive' });
    expect((await parseJsonResponse(response)).data.expiresAt).toBeNull();
  });

  it('needs a signed-in person, a text id and a known storage', async () => {
    expect((await put(text('x'), { id: '../u2', storage: 'app' })).status).toBe(
      400,
    );
    expect((await put(text('x'), { id: ID, storage: 'ftp' })).status).toBe(400);
    mockAuth.mockResolvedValue(null);
    expect((await put(text('x'))).status).toBe(401);
    expect((await GET(new NextRequest(url()))).status).toBe(401);
  });

  it("never reaches another person's text", async () => {
    await put(text('theirs'));
    mockAuth.mockResolvedValue({ user: { id: 'u2' } });
    const response = await GET(new NextRequest(url()));
    expect(response.status).toBe(404);
    expect((await parseJsonResponse(response)).code).toBe('RUN_FILES_MISSING');
  });

  it('refuses an empty text, one too large, and a switched-off workflow', async () => {
    expect((await put(new Uint8Array())).status).toBe(400);
    expect(
      (await put(new Uint8Array(STORED_SOURCE_TEXT_MAX_BYTES + 1))).status,
    ).toBe(413);
    expect(
      (await put(new Uint8Array(STORED_SOURCE_TEXT_MAX_BYTES).fill(97))).status,
    ).toBe(200);
    workflowEnabled.mockResolvedValue(false);
    expect((await put(text('x'))).status).toBe(403);
  });

  it('is kept alive, or only asked about, and reported gone when it is', async () => {
    const touch = (body: unknown) =>
      POST(
        new NextRequest(url(), { method: 'POST', body: JSON.stringify(body) }),
      );
    const gone = await touch({});
    expect(gone.status).toBe(404);
    expect((await parseJsonResponse(gone)).code).toBe('RUN_FILES_MISSING');
    await put(text('x'));
    for (const body of [{}, { touch: false }]) {
      const response = await touch(body);
      expect(response.status).toBe(200);
      expect((await parseJsonResponse(response)).data.files).toBe(1);
    }
  });

  it('is deleted, and deleting one already gone succeeds', async () => {
    await put(text('x'));
    const remove = () => DELETE(new NextRequest(url(), { method: 'DELETE' }));
    expect((await remove()).status).toBe(200);
    expect(drive.size).toBe(0);
    expect((await remove()).status).toBe(200);
  });
});
