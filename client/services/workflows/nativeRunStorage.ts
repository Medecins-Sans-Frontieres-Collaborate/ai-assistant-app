'use client';

import { loadMasterKey } from '@/client/services/backup/keystore';

import { computeKeyId } from '@/lib/utils/shared/backupCrypto/keyDerivation';
import { FormattedDocumentRun } from '@/lib/utils/shared/translation/formattedDocument';
import {
  NativeRunBackend,
  NativeRunRef,
  RUN_KEY_HEADER,
  RUN_RECORD_ID,
  RunFileIntegrityError,
  bytesToBase64,
  decryptRunFile,
  deriveRunKey,
  encryptRunFile,
  isEncryptedRunFile,
  parseRunFileUrl,
  runFileUrl,
} from '@/lib/utils/shared/translation/nativeRunStorage';

/**
 * The browser's side of a translation run's storage (see the conventions
 * in nativeRunStorage.ts under lib/utils/shared/translation): reading a
 * run's files, saving its record, and keeping its files alive. Everything
 * here goes through the server; nothing is kept in browser storage.
 */

const RUN_ROUTE = '/api/document-translation/native/run';

/** What is needed to reach a run's files. */
export type RunAccess = Pick<NativeRunRef, 'runId' | 'backend' | 'keyId'>;

/** The run's files are gone: expired from app storage, or deleted. */
export class RunMissingError extends Error {
  constructor() {
    super('The files of this translation are no longer stored');
    this.name = 'RunMissingError';
  }
}

/**
 * The run is encrypted and this device cannot read it: it holds no backup
 * key (`no-key`) or a different one (`other-key`).
 */
export class RunLockedError extends Error {
  constructor(readonly reason: 'no-key' | 'other-key') {
    super(
      reason === 'no-key'
        ? 'This translation is encrypted and this device has no backup key'
        : 'This translation is encrypted with a different backup key',
    );
    this.name = 'RunLockedError';
  }
}

/** A request the server refused, with its error code when it gave one. */
export class RunRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RunRequestError';
  }
}

/** Whether an error says OneDrive could not be used for this person. */
export function isOneDriveUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('M365_');
}

/**
 * Turns a refused response into the error the screens act on.
 *
 * @param response - A response that is not OK.
 * @param fallback - The message when the server gave none.
 */
export async function runErrorFrom(
  response: Response,
  fallback: string,
): Promise<Error> {
  const parsed = await response.json().catch(() => null);
  const code = typeof parsed?.code === 'string' ? parsed.code : undefined;
  if (code === 'RUN_FILES_MISSING') return new RunMissingError();
  if (code === 'RUN_KEY_MISMATCH') return new RunLockedError('other-key');
  if (code === 'RUN_LOCKED') return new RunLockedError('no-key');
  return new RunRequestError(
    parsed?.error || `${fallback} (${response.status})`,
    code,
  );
}

/**
 * Starts a new run's identity: a fresh id, in the given backend, encrypted
 * when this device holds the person's backup key.
 *
 * @param backend - Where the run's files will live.
 */
export async function newRunAccess(
  backend: NativeRunBackend,
): Promise<RunAccess> {
  const master = await loadMasterKey().catch(() => null);
  return {
    runId: crypto.randomUUID(),
    backend,
    ...(master ? { keyId: await computeKeyId(master) } : {}),
  };
}

/**
 * The key of an encrypted run.
 *
 * @returns The key, or undefined for a run that is not encrypted.
 * @throws RunLockedError when this device cannot derive it.
 */
export async function runKey(
  access: RunAccess,
): Promise<Uint8Array | undefined> {
  if (!access.keyId) return undefined;
  const master = await loadMasterKey().catch(() => null);
  if (!master) throw new RunLockedError('no-key');
  if ((await computeKeyId(master)) !== access.keyId) {
    throw new RunLockedError('other-key');
  }
  return deriveRunKey(master, access.runId);
}

/** The headers that let the server read and write an encrypted run. */
export async function runKeyHeaders(
  access: RunAccess,
): Promise<Record<string, string>> {
  const key = await runKey(access);
  return key ? { [RUN_KEY_HEADER]: bytesToBase64(key) } : {};
}

/**
 * Reads one file of a run, decrypted.
 *
 * @param url - A path made by `runFileUrl` (a run's `pdfUrl`, a page
 *   image's `previewUrl`, ...).
 * @throws RunMissingError when the file is gone, RunLockedError when it is
 *   encrypted and this device cannot read it.
 */
export async function fetchRunFile(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const named = parseRunFileUrl(url);
  if (!named) throw new Error('Not a file of a translation run');
  const response = await fetch(url, { signal });
  if (!response.ok) throw await runErrorFrom(response, 'Loading failed');
  const stored = new Uint8Array(await response.arrayBuffer());
  if (!isEncryptedRunFile(stored)) return stored;
  const master = await loadMasterKey().catch(() => null);
  if (!master) throw new RunLockedError('no-key');
  try {
    return await decryptRunFile(
      await deriveRunKey(master, named.runId),
      named.runId,
      named.fileId,
      stored,
    );
  } catch (error) {
    if (error instanceof RunFileIntegrityError) {
      throw new RunLockedError('other-key');
    }
    throw error;
  }
}

/** The id of the file a run's URL names, or null for any other URL. */
const fileIdOf = (url: string): string | null =>
  parseRunFileUrl(url)?.fileId ?? null;

/**
 * Ids of the files a run still uses. Everything else in its folder is left
 * over from an earlier render and can be deleted.
 *
 * @param run - The run as it stands.
 */
export function runFilesInUse(run: FormattedDocumentRun): string[] {
  const ids = [
    run.sourceId,
    run.unitsId,
    ...(run.pdfUrl ? [fileIdOf(run.pdfUrl)] : []),
    ...(run.documentUrl ? [fileIdOf(run.documentUrl)] : []),
    ...run.pageImages.flatMap((image) => [
      fileIdOf(image.previewUrl),
      fileIdOf(image.checkUrl),
    ]),
  ];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/**
 * Saves a run's record, encrypted in the browser when the run is.
 *
 * @throws RunLockedError, or a RunRequestError when the server refuses.
 */
export async function saveRunRecord(
  access: RunAccess,
  run: FormattedDocumentRun,
  signal?: AbortSignal,
): Promise<void> {
  const plain = new TextEncoder().encode(JSON.stringify(run));
  const key = await runKey(access);
  const body = key
    ? await encryptRunFile(key, access.runId, RUN_RECORD_ID, plain)
    : plain;
  const query = new URLSearchParams({
    run: access.runId,
    storage: access.backend,
  });
  const response = await fetch(
    `/api/document-translation/native/file?${query.toString()}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(body),
      signal,
    },
  );
  if (!response.ok) throw await runErrorFrom(response, 'Saving failed');
}

/**
 * Loads a run's record.
 *
 * @throws RunMissingError, RunLockedError, or an Error when the record is
 *   not readable.
 */
export async function loadRunRecord(
  access: RunAccess,
  signal?: AbortSignal,
): Promise<FormattedDocumentRun> {
  // Checked first, so another device's key is named as the reason.
  await runKey(access);
  const bytes = await fetchRunFile(runFileUrl(access, RUN_RECORD_ID), signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as FormattedDocumentRun;
  } catch {
    throw new Error('The saved translation could not be read');
  }
}

/**
 * Keeps a run's files in step with the browser: leftovers are deleted and,
 * in app storage, the files are kept from expiring.
 *
 * @param access - The run.
 * @param keep - Ids still in use (see {@link runFilesInUse}); absent keeps
 *   everything.
 * @param touch - False only asks when the run expires.
 * @returns When app storage will delete the run; undefined on OneDrive.
 * @throws RunMissingError when the run's files are gone.
 */
export async function syncRun(
  access: RunAccess,
  keep?: string[],
  touch = true,
): Promise<{ expiresAt?: string }> {
  const response = await fetch(RUN_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: access.runId,
      storage: access.backend,
      ...(keep ? { keep } : {}),
      touch,
    }),
  });
  if (!response.ok) throw await runErrorFrom(response, 'Checking failed');
  const parsed = await response.json().catch(() => null);
  const expiresAt = parsed?.data?.expiresAt;
  return typeof expiresAt === 'string' ? { expiresAt } : {};
}

/** Deletes a run and its files; a failure is reported, not thrown. */
export async function deleteRun(access: RunAccess): Promise<boolean> {
  const query = new URLSearchParams({
    run: access.runId,
    storage: access.backend,
  });
  try {
    const response = await fetch(`${RUN_ROUTE}?${query.toString()}`, {
      method: 'DELETE',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Saves one of a run's files to the person's device.
 *
 * @param url - The file's path (a run's `pdfUrl`, or one of its `exportUrls`).
 * @param filename - The name to save it under.
 * @param contentType - The file's media type; a PDF unless said otherwise.
 * @throws RunMissingError or RunLockedError as {@link fetchRunFile} does.
 */
export async function downloadRunFile(
  url: string,
  filename: string,
  contentType: string = 'application/pdf',
): Promise<void> {
  const bytes = await fetchRunFile(url);
  const link = document.createElement('a');
  const href = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: contentType }),
  );
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
