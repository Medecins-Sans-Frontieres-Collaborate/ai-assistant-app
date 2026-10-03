/**
 * The stored preview of a delivered file: its tables, capped at PREVIEW_ROWS
 * rows each, written once when the file is validated so that opening a file
 * never parses it again. Server-only.
 *
 * Lives in the ADMIN container beside the validation state, never in the
 * delivery container (the app does not write there). It holds every column
 * the file has; what a given person may see of it is decided when it is
 * SERVED (previewModel.ts), so a change to the field policy needs nothing
 * regenerated.
 *
 * Raw telemetry is never stored here — it would be a second copy of names
 * and e-mail addresses. It is read from the delivery container on demand.
 */
import {
  OVERWRITE_BLOB,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { getPayloadCache } from '@/lib/services/agentAccess/payloadCache';
import { DerivedTable } from '@/lib/services/analytics/tables';
import {
  ANALYTICS_PREVIEW_VERSION,
  analyticsPreviewPath,
} from '@/lib/services/analytics/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { gunzipSync, gzipSync } from 'zlib';

interface StoredPreview {
  version: number;
  /** The delivered blob this was read from. */
  blobVersion: string;
  encoding: 'gzip-base64';
  /** gzip(JSON(DerivedTable[])), base64. */
  data: string;
}

const CACHE_PREFIX = 'analytics-preview:';

function cacheKey(fileId: string, blobVersion: string): string {
  return `${CACHE_PREFIX}${fileId}:${blobVersion}`;
}

/** Last writer wins: a preview is derived data, rebuilt whole by one run. */
export async function writePreview(
  storage: BlobStorage,
  fileId: string,
  blobVersion: string,
  tables: readonly DerivedTable[],
): Promise<void> {
  const payload: StoredPreview = {
    version: ANALYTICS_PREVIEW_VERSION,
    blobVersion,
    encoding: 'gzip-base64',
    data: gzipSync(Buffer.from(JSON.stringify(tables), 'utf8')).toString(
      'base64',
    ),
  };
  await uploadJson(
    storage,
    analyticsPreviewPath(fileId),
    payload,
    OVERWRITE_BLOB,
    'analytics.writePreview',
  );
  getPayloadCache().deleteByPrefix(`${CACHE_PREFIX}${fileId}:`);
}

/**
 * The preview for exactly this version of the file, or null when there is
 * none — never one that was read from an older delivery at the same path.
 */
export async function readPreview(
  storage: BlobStorage,
  fileId: string,
  blobVersion: string,
): Promise<DerivedTable[] | null> {
  const entry = await getPayloadCache().getOrLoadImmutable<DerivedTable[]>(
    cacheKey(fileId, blobVersion),
    async () => {
      const result = await downloadBlob(
        storage,
        analyticsPreviewPath(fileId),
        'analytics.readPreview',
      );
      if (result === null) return null;
      const stored = JSON.parse(
        result.buffer.toString('utf8'),
      ) as Partial<StoredPreview>;
      if (
        stored.version !== ANALYTICS_PREVIEW_VERSION ||
        stored.blobVersion !== blobVersion ||
        stored.encoding !== 'gzip-base64' ||
        typeof stored.data !== 'string'
      ) {
        return null;
      }
      const json = gunzipSync(Buffer.from(stored.data, 'base64'));
      return {
        value: JSON.parse(json.toString('utf8')) as DerivedTable[],
        bytes: json.length,
      };
    },
  );
  return entry?.value ?? null;
}

export async function deletePreview(
  storage: BlobStorage,
  fileId: string,
): Promise<void> {
  await storage.deleteIfExists(analyticsPreviewPath(fileId));
  getPayloadCache().deleteByPrefix(`${CACHE_PREFIX}${fileId}:`);
}
