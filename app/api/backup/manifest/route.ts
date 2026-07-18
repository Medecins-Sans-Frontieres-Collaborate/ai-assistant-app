import { NextRequest } from 'next/server';

import {
  BackupConflictError,
  KEY_ID_REGEX,
  isValidConversationId,
  isValidRev,
  readManifest,
  writeManifest,
} from '@/lib/services/backup/server/backupBlobStore';
import {
  rateLimitedResponse,
  readBoundedBody,
} from '@/lib/services/backup/server/routeHelpers';
import { BackupManifest } from '@/lib/services/backup/types';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { classifyStorageError } from '@/lib/utils/server/blob/storageErrors';

import { auth } from '@/auth';

/**
 * GET/PUT `/api/backup/manifest` — the plaintext manifest for the
 * E2E-encrypted chat backup. Auth-only (no feature gate — LD is client-side
 * in this app); the server interprets NOTHING but this manifest, and it
 * carries only ids, revs, timestamps, sizes, and the key fingerprint.
 *
 * PUT is a compare-and-swap: `If-Match: <etag>` against the current blob
 * (absent on first create). Guard order is contract, not style:
 *   shape → keyId change requires epoch+1 (409 BACKUP_KEY_MISMATCH)
 *         → version must be exactly current+1 (409 BACKUP_VERSION_CONFLICT —
 *           a wrong next-version under CAS is a concurrency loss the client
 *           must resolve by pull-merge-repush, not a malformed request)
 *         → CAS write (Azure 412 → 409 BACKUP_VERSION_CONFLICT)
 * The keyId guard is what makes a stale device unable to clobber a rotated
 * backup even with a fresh etag.
 */

/** Manifest is small JSON (ids + metadata); 1MB is far above any real corpus. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Sanity cap on manifest entries to bound validation and storage work. */
const MAX_CONVERSATION_ENTRIES = 10000;

const limiter = RateLimiter.createScoped(60, 1);

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

/**
 * Structural validation of a client-supplied manifest. Every id and rev is
 * regex-checked here so nothing user-controlled can reach path interpolation
 * in later blob reads.
 */
function validateManifestShape(
  body: unknown,
): { ok: true; manifest: BackupManifest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Manifest must be a JSON object' };
  }
  const m = body as Record<string, unknown>;

  if (m.schemaVersion !== 1) {
    return { ok: false, error: 'Unsupported manifest schemaVersion' };
  }
  const disabled = m.disabled === true;
  if (m.keyId === null) {
    if (!disabled) {
      return { ok: false, error: 'keyId may only be null when disabled' };
    }
  } else if (typeof m.keyId !== 'string' || !KEY_ID_REGEX.test(m.keyId)) {
    return { ok: false, error: 'Invalid keyId' };
  }
  if (
    typeof m.epoch !== 'number' ||
    !Number.isInteger(m.epoch) ||
    m.epoch < 1
  ) {
    return { ok: false, error: 'Invalid epoch' };
  }
  if (
    typeof m.version !== 'number' ||
    !Number.isInteger(m.version) ||
    m.version < 1
  ) {
    return { ok: false, error: 'Invalid version' };
  }
  if (!isIsoTimestamp(m.updatedAt)) {
    return { ok: false, error: 'Invalid updatedAt' };
  }

  if (m.folders !== null) {
    if (!m.folders || typeof m.folders !== 'object') {
      return { ok: false, error: 'Invalid folders entry' };
    }
    const folders = m.folders as Record<string, unknown>;
    if (typeof folders.rev !== 'string' || !isValidRev(folders.rev)) {
      return { ok: false, error: 'Invalid folders rev' };
    }
    if (!isIsoTimestamp(folders.updatedAt)) {
      return { ok: false, error: 'Invalid folders updatedAt' };
    }
  }

  if (
    !m.conversations ||
    typeof m.conversations !== 'object' ||
    Array.isArray(m.conversations)
  ) {
    return { ok: false, error: 'Invalid conversations map' };
  }
  const entries = Object.entries(m.conversations as Record<string, unknown>);
  if (entries.length > MAX_CONVERSATION_ENTRIES) {
    return { ok: false, error: 'Too many conversation entries' };
  }
  for (const [id, rawEntry] of entries) {
    if (!isValidConversationId(id)) {
      return { ok: false, error: 'Invalid conversation id in manifest' };
    }
    if (!rawEntry || typeof rawEntry !== 'object') {
      return { ok: false, error: 'Invalid conversation entry' };
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry.deleted !== undefined && entry.deleted !== true) {
      return { ok: false, error: 'Invalid conversation tombstone' };
    }
    const isTombstone = entry.deleted === true;
    // Tombstones have no blob and their rev is never dereferenced, and a
    // conversation deleted before its first push has no rev at all — so
    // tombstone entries may carry an empty or absent rev.
    if (isTombstone) {
      if (
        entry.rev !== undefined &&
        entry.rev !== '' &&
        (typeof entry.rev !== 'string' || !isValidRev(entry.rev))
      ) {
        return { ok: false, error: 'Invalid conversation rev' };
      }
      if (!isIsoTimestamp(entry.deletedAt)) {
        return { ok: false, error: 'Invalid conversation deletedAt' };
      }
    } else if (typeof entry.rev !== 'string' || !isValidRev(entry.rev)) {
      return { ok: false, error: 'Invalid conversation rev' };
    }
    if (!isIsoTimestamp(entry.updatedAt)) {
      return { ok: false, error: 'Invalid conversation updatedAt' };
    }
    if (
      typeof entry.size !== 'number' ||
      !Number.isFinite(entry.size) ||
      entry.size < 0
    ) {
      return { ok: false, error: 'Invalid conversation size' };
    }
  }

  return { ok: true, manifest: body as BackupManifest };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = getUserIdFromSession(session);
  if (userId === 'anonymous') return unauthorizedResponse();

  const limit = limiter.checkLimit(userId);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
  }

  try {
    const storage = createBlobStorageClient(session);
    const result = await readManifest(storage, userId);
    if (result === null) {
      return errorResponse(
        'Backup not found',
        404,
        undefined,
        'BACKUP_NOT_FOUND',
      );
    }
    return successResponse({ manifest: result.manifest, etag: result.etag });
  } catch (error) {
    const { errorClass, status, message } = classifyStorageError(error);
    console.error(
      `[BackupManifestRoute] GET failed (class=${errorClass}, status=${status}):`,
      error,
    );
    return errorResponse(message, status, undefined, errorClass.toUpperCase());
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = getUserIdFromSession(session);
  if (userId === 'anonymous') return unauthorizedResponse();

  const limit = limiter.checkLimit(userId);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
  }

  const body = await readBoundedBody(request, MAX_MANIFEST_BYTES);
  if (body === null) {
    return payloadTooLargeResponse('1MB');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return badRequestResponse('Manifest must be valid JSON');
  }

  const validation = validateManifestShape(parsed);
  if (!validation.ok) {
    return badRequestResponse(validation.error);
  }
  const incoming = validation.manifest;
  const ifMatchEtag = request.headers.get('if-match');
  // Only an exact quoted strong ETag may reach the storage CAS condition —
  // `If-Match: *` matches any blob and would reduce the CAS to a blind write,
  // and a weak validator (W/…) can never strong-match.
  if (ifMatchEtag !== null && !/^"[^"]*"$/.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  try {
    const storage = createBlobStorageClient(session);
    const existing = await readManifest(storage, userId);

    if (existing !== null) {
      if (!ifMatchEtag) {
        return errorResponse(
          'Backup manifest already exists; If-Match header required',
          409,
          undefined,
          'BACKUP_VERSION_CONFLICT',
        );
      }
      // A keyId change (rotation, reset, disable, re-enroll) MUST bump the
      // epoch by exactly 1 — this is the server-side backstop that prevents
      // a device holding a stale key from silently clobbering a rotated
      // backup, without the server ever tracking devices.
      if (
        incoming.keyId !== existing.manifest.keyId &&
        incoming.epoch !== existing.manifest.epoch + 1
      ) {
        return errorResponse(
          'Backup key changed without epoch increment',
          409,
          undefined,
          'BACKUP_KEY_MISMATCH',
        );
      }
      if (incoming.version !== existing.manifest.version + 1) {
        // The CAS loser lands here after another device advanced the
        // manifest: this is a concurrency loss, and the client's recovery
        // loop (pull → merge → re-push) triggers on this code — not on 400.
        return errorResponse(
          `Manifest version must be exactly ${existing.manifest.version + 1}`,
          409,
          undefined,
          'BACKUP_VERSION_CONFLICT',
        );
      }
    } else if (incoming.version !== 1) {
      return badRequestResponse('Initial manifest version must be 1');
    }

    const etag = await writeManifest(
      storage,
      userId,
      incoming,
      existing === null ? null : ifMatchEtag,
    );
    return successResponse({ etag, version: incoming.version });
  } catch (error) {
    if (error instanceof BackupConflictError) {
      return errorResponse(
        'Backup manifest was modified by another device',
        409,
        undefined,
        'BACKUP_VERSION_CONFLICT',
      );
    }
    const { errorClass, status, message } = classifyStorageError(error);
    console.error(
      `[BackupManifestRoute] PUT failed (class=${errorClass}, status=${status}):`,
      error,
    );
    return errorResponse(message, status, undefined, errorClass.toUpperCase());
  }
}
