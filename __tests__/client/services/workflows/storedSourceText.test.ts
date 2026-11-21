import { loadMasterKey } from '@/client/services/backup/keystore';
import {
  RunLockedError,
  RunMissingError,
} from '@/client/services/workflows/nativeRunStorage';
import {
  deleteSourceText,
  loadSourceText,
  storeSourceText,
  touchSourceText,
} from '@/client/services/workflows/storedSourceText';

import {
  RUN_KEY_HEADER,
  isEncryptedRunFile,
} from '@/lib/utils/shared/translation/nativeRunStorage';
import { sourceTextFingerprint } from '@/lib/utils/shared/translation/storedSourceText';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/backup/keystore', () => ({
  loadMasterKey: vi.fn(),
}));

const MASTER = new Uint8Array(32).fill(5);
const TEXT = 'Le rapport annuel — édition 2026. '.repeat(50);

interface Call {
  method: string;
  storage: string | null;
  id: string | null;
  headers: Headers;
}

/** A server keeping texts by id, refusing the storages it is told to. */
function server(refuse: Record<string, { status: number; code: string }> = {}) {
  const texts = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const query = new URL(url, 'http://localhost').searchParams;
      const id = query.get('id');
      const storage = query.get('storage');
      const method = init.method ?? 'GET';
      calls.push({ method, storage, id, headers: new Headers(init.headers) });
      const refusal = refuse[storage ?? ''];
      if (refusal) {
        return Response.json(
          { error: 'refused', code: refusal.code },
          { status: refusal.status },
        );
      }
      const gone = () =>
        Response.json(
          { error: 'gone', code: 'RUN_FILES_MISSING' },
          { status: 404 },
        );
      if (method === 'PUT') {
        texts.set(id!, new Uint8Array(init.body as Uint8Array));
        return Response.json({
          success: true,
          data: {
            expiresAt: storage === 'app' ? '2026-11-23T00:00:00.000Z' : null,
          },
        });
      }
      if (method === 'DELETE') {
        texts.delete(id!);
        return Response.json({ success: true });
      }
      if (!texts.has(id!)) return gone();
      if (method === 'POST') {
        return Response.json({
          success: true,
          data: { expiresAt: '2026-11-24T00:00:00.000Z' },
        });
      }
      return new Response(new Uint8Array(texts.get(id!)!));
    }),
  );
  return { texts, calls };
}

beforeEach(() => {
  vi.mocked(loadMasterKey).mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('storing a source text', () => {
  it('stores it as it is on a device without a backup key', async () => {
    const { texts } = server();
    const ref = await storeSourceText(TEXT, 'app');
    expect(ref).toMatchObject({
      backend: 'app',
      fingerprint: sourceTextFingerprint(TEXT),
      expiresAt: '2026-11-23T00:00:00.000Z',
    });
    expect(ref.keyId).toBeUndefined();
    expect(new TextDecoder().decode(texts.get(ref.id))).toBe(TEXT);
    expect(await loadSourceText(ref)).toBe(TEXT);
  });

  it('encrypts it in the browser with one, and never sends a key', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(MASTER);
    const { texts, calls } = server();
    const ref = await storeSourceText(TEXT, 'onedrive');
    expect(ref.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(ref.expiresAt).toBeUndefined();
    const stored = texts.get(ref.id)!;
    expect(isEncryptedRunFile(stored)).toBe(true);
    expect(new TextDecoder().decode(stored)).not.toContain('rapport');
    expect(await loadSourceText(ref)).toBe(TEXT);
    for (const call of calls) {
      expect(call.headers.has(RUN_KEY_HEADER)).toBe(false);
    }
  });

  it('writes an edited text over the stored one', async () => {
    const { texts } = server();
    const first = await storeSourceText(TEXT, 'app');
    const second = await storeSourceText(`${TEXT} more`, 'app', first);
    expect(second.id).toBe(first.id);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(texts.size).toBe(1);
    expect(await loadSourceText(second)).toBe(`${TEXT} more`);
  });

  it('uses app storage when OneDrive cannot be used', async () => {
    const { calls } = server({
      onedrive: { status: 403, code: 'M365_CONSENT_MISSING' },
    });
    const ref = await storeSourceText(TEXT, 'onedrive');
    expect(ref.backend).toBe('app');
    expect(calls.map((call) => call.storage)).toEqual(['onedrive', 'app']);
  });

  it('starts a new place when the old one was encrypted with a key now gone', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(MASTER);
    server();
    const first = await storeSourceText(TEXT, 'app');
    vi.mocked(loadMasterKey).mockResolvedValue(null);
    const second = await storeSourceText(`${TEXT} more`, 'app', first);
    expect(second.id).not.toBe(first.id);
    expect(second.keyId).toBeUndefined();
  });

  it('passes on any other refusal, so the text stays in the browser', async () => {
    server({ app: { status: 500, code: 'INTERNAL' } });
    await expect(storeSourceText(TEXT, 'app')).rejects.toThrow('refused');
  });
});

describe('reading a stored source text', () => {
  it('names a missing text and a key this device does not hold', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(MASTER);
    server();
    const ref = await storeSourceText(TEXT, 'app');
    vi.mocked(loadMasterKey).mockResolvedValue(null);
    await expect(loadSourceText(ref)).rejects.toMatchObject({
      reason: 'no-key',
    });
    vi.mocked(loadMasterKey).mockResolvedValue(new Uint8Array(32).fill(6));
    await expect(loadSourceText(ref)).rejects.toBeInstanceOf(RunLockedError);

    vi.mocked(loadMasterKey).mockResolvedValue(MASTER);
    expect(await deleteSourceText(ref)).toBe(true);
    await expect(loadSourceText(ref)).rejects.toBeInstanceOf(RunMissingError);
    await expect(touchSourceText(ref)).rejects.toBeInstanceOf(RunMissingError);
  });

  it('reports the expiry a touch returns', async () => {
    server();
    const ref = await storeSourceText(TEXT, 'app');
    expect(await touchSourceText(ref, false)).toBe('2026-11-24T00:00:00.000Z');
  });
});
