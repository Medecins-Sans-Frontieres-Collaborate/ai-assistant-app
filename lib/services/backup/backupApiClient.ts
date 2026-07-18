import type {
  BackupApi,
  BackupApiErrorCode,
  BackupManifest,
  ManifestFetchResult,
} from '@/lib/services/backup/types';

/**
 * Typed fetch wrapper for the /api/backup routes. Parses the standard
 * apiResponse error shape ({ error, details?, code? }) into BackupApiError so
 * the sync engine can branch on `code` without touching HTTP details.
 */

export class BackupApiError extends Error {
  constructor(
    message: string,
    public readonly code: BackupApiErrorCode,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'BackupApiError';
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set<BackupApiErrorCode>([
  'BACKUP_VERSION_CONFLICT',
  'BACKUP_KEY_MISMATCH',
  'BACKUP_NOT_FOUND',
  'UNAUTHORIZED',
  'PAYLOAD_TOO_LARGE',
]);

function codeFromStatus(status: number): BackupApiErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 404:
      return 'BACKUP_NOT_FOUND';
    case 409:
      return 'BACKUP_VERSION_CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    default:
      return 'UNKNOWN';
  }
}

async function errorFromResponse(res: Response): Promise<BackupApiError> {
  let message = `Backup API request failed (${res.status})`;
  let code: BackupApiErrorCode = codeFromStatus(res.status);
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (typeof body.error === 'string' && body.error) message = body.error;
    if (typeof body.code === 'string' && KNOWN_CODES.has(body.code)) {
      code = body.code as BackupApiErrorCode;
    }
  } catch {
    // Non-JSON error body (proxy/HTML error page) — keep the status-based code.
  }
  return new BackupApiError(message, code, res.status);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createBackupApiClient(fetchImpl?: FetchLike): BackupApi {
  const doFetch: FetchLike = async (input, init) => {
    const f = fetchImpl ?? globalThis.fetch;
    try {
      return await f(input, init);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Network request failed';
      throw new BackupApiError(message, 'NETWORK', 0);
    }
  };

  const readJsonData = async <T>(res: Response): Promise<T> => {
    const body = (await res.json()) as { data?: T };
    return body.data as T;
  };

  const blobUrl = (id: string, rev: string): string =>
    `/api/backup/conversations/${encodeURIComponent(id)}?rev=${encodeURIComponent(rev)}`;

  const foldersUrl = (rev: string): string =>
    `/api/backup/folders?rev=${encodeURIComponent(rev)}`;

  const expectOk = async (res: Response): Promise<void> => {
    if (!res.ok) throw await errorFromResponse(res);
  };

  const readBytes = async (res: Response): Promise<Uint8Array> => {
    if (!res.ok) throw await errorFromResponse(res);
    return new Uint8Array(await res.arrayBuffer());
  };

  const putBytes = async (url: string, bytes: Uint8Array): Promise<void> => {
    const res = await doFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      // Copy into a fresh ArrayBuffer so TS accepts it as BodyInit even when
      // the source view sits on a SharedArrayBuffer.
      body: new Uint8Array(bytes).buffer as ArrayBuffer,
    });
    await expectOk(res);
  };

  return {
    async getManifest(): Promise<ManifestFetchResult | null> {
      const res = await doFetch('/api/backup/manifest', { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw await errorFromResponse(res);
      return await readJsonData<ManifestFetchResult>(res);
    },

    async putManifest(
      manifest: BackupManifest,
      opts: { ifMatchEtag: string | null },
    ): Promise<{ etag: string }> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (opts.ifMatchEtag !== null) headers['If-Match'] = opts.ifMatchEtag;
      const res = await doFetch('/api/backup/manifest', {
        method: 'PUT',
        headers,
        body: JSON.stringify(manifest),
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readJsonData<{ etag: string }>(res);
    },

    async putConversationBlob(
      id: string,
      rev: string,
      bytes: Uint8Array,
    ): Promise<void> {
      await putBytes(blobUrl(id, rev), bytes);
    },

    async getConversationBlob(id: string, rev: string): Promise<Uint8Array> {
      return readBytes(await doFetch(blobUrl(id, rev), { method: 'GET' }));
    },

    async deleteConversationBlob(id: string, rev: string): Promise<void> {
      await expectOk(await doFetch(blobUrl(id, rev), { method: 'DELETE' }));
    },

    async putFoldersBlob(rev: string, bytes: Uint8Array): Promise<void> {
      await putBytes(foldersUrl(rev), bytes);
    },

    async getFoldersBlob(rev: string): Promise<Uint8Array> {
      return readBytes(await doFetch(foldersUrl(rev), { method: 'GET' }));
    },

    async deleteBackup(): Promise<void> {
      await expectOk(await doFetch('/api/backup', { method: 'DELETE' }));
    },
  };
}
