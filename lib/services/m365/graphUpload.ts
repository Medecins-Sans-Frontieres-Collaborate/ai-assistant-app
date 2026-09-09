/**
 * Shared Graph upload-session fragment uploader — the single implementation
 * behind /api/m365/save and the OneDrive backup store (they previously
 * carried drifted copies).
 *
 * Graph semantics this encodes:
 *   - fragments must be 320KiB multiples; 5MiB (16 × 320KiB) per PUT
 *   - transient fragment failures (429/5xx/network) are retried, resuming
 *     from the session's `nextExpectedRanges` rather than restarting
 *   - `conflictBehavior=fail` is evaluated at the FINAL fragment commit —
 *     that 409 surfaces as {@link GraphUploadConflictError} so create-only
 *     callers (backup) can treat it as idempotent success
 *   - an aborted upload DELETEs the session so no orphan lingers until
 *     Graph expires it
 *
 * The uploadUrl is pre-authenticated; no token accompanies fragment PUTs,
 * which also makes them immune to token expiry mid-upload.
 */
import { M365Error } from '@/lib/services/m365/graphApi';

/** Graph simple content PUT cap; larger bodies need an upload session. */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
// 16 × 320KiB — Graph upload-session fragments must be 320KiB multiples.
export const CHUNK_SIZE = 16 * 327_680;

/** Attempts per fragment (first try + retries). */
const FRAGMENT_ATTEMPTS = 3;
/** Ceiling on honoring Retry-After — the route has a maxDuration budget. */
const MAX_RETRY_WAIT_MS = 10_000;

/** Graph 409 at the final-fragment commit (conflictBehavior=fail lost). */
export class GraphUploadConflictError extends Error {
  constructor() {
    super('An item with this name already exists');
    this.name = 'GraphUploadConflictError';
  }
}

export interface UploadedItemShape {
  id?: string;
  name?: string;
  webUrl?: string;
  eTag?: string;
  parentReference?: { driveId?: string };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryWaitMs(response: Response | null, attempt: number): number {
  const retryAfter = Number(response?.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS);
  }
  return Math.min(1000 * attempt, MAX_RETRY_WAIT_MS);
}

/** Best-effort session cancel — an abandoned session is Graph-side litter. */
async function cancelSession(uploadUrl: string): Promise<void> {
  await fetch(uploadUrl, { method: 'DELETE' }).catch(() => undefined);
}

/**
 * Re-reads the session to find where Graph wants the upload to resume.
 * Returns null when the session state is unreadable (caller retries the
 * current fragment as-is).
 */
async function nextExpectedOffset(uploadUrl: string): Promise<number | null> {
  try {
    const response = await fetch(uploadUrl);
    if (!response.ok) return null;
    const body = (await response.json()) as { nextExpectedRanges?: string[] };
    const range = body.nextExpectedRanges?.[0];
    if (!range) return null;
    const start = Number.parseInt(range, 10);
    return Number.isFinite(start) && start >= 0 ? start : null;
  } catch {
    return null;
  }
}

export interface UploadSessionOptions {
  /**
   * Fail loudly when the commit response carries no item id (default) —
   * callers that bind on the created item (doc-sync) must not get a
   * phantom success. Callers that ignore the item (backup) pass false.
   */
  requireItem?: boolean;
}

export async function uploadSessionFragments(
  uploadUrl: string,
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
  { requireItem = true }: UploadSessionOptions = {},
): Promise<UploadedItemShape> {
  let offset = 0;
  let attempts = 0;
  while (offset < bytes.length) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.length);
    const fragment = bytes.slice(offset, end);
    let response: Response | null = null;
    try {
      response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
        },
        body: fragment,
      });
    } catch {
      response = null; // network failure — retryable like a 5xx
    }

    if (response?.ok) {
      if (end === bytes.length) {
        const item = (await response
          .json()
          .catch(() => null)) as UploadedItemShape | null;
        if (!requireItem) return item ?? {};
        if (!item?.id) {
          // The commit succeeded but the item metadata is gone — callers
          // (doc-sync) bind on the id, so a silent success would strand
          // them. Loud beats a phantom "saved" with nothing to bind.
          throw new M365Error(
            'The upload completed but Microsoft Graph did not return the created item — check the destination folder before retrying',
            'graph_error',
            502,
          );
        }
        return item;
      }
      offset = end;
      attempts = 0;
      continue;
    }

    // conflictBehavior=fail loses at the final-fragment commit.
    if (response?.status === 409 && end === bytes.length) {
      throw new GraphUploadConflictError();
    }

    const retryable =
      !response || response.status === 429 || response.status >= 500;
    attempts += 1;
    if (retryable && attempts < FRAGMENT_ATTEMPTS) {
      await sleep(retryWaitMs(response, attempts));
      const resumeAt = await nextExpectedOffset(uploadUrl);
      if (resumeAt !== null && resumeAt <= bytes.length) {
        offset = resumeAt;
      }
      continue;
    }

    await cancelSession(uploadUrl);
    if (response?.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new M365Error(
        'Microsoft Graph throttled the upload',
        'rate_limited',
        429,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5,
      );
    }
    throw new M365Error(
      `Chunk upload failed (${response ? response.status : 'network error'})`,
      'graph_error',
      502,
    );
  }
  // Zero-length uploads never enter the loop; sessions require ≥1 fragment.
  throw new M365Error('Nothing to upload', 'graph_error', 502);
}
