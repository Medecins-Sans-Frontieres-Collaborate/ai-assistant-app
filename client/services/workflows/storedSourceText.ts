'use client';

import {
  RunAccess,
  RunLockedError,
  RunMissingError,
  isOneDriveUnavailable,
  newRunAccess,
  runErrorFrom,
  runKey,
} from '@/client/services/workflows/nativeRunStorage';

import {
  NativeRunBackend,
  RUN_RECORD_ID,
  RunFileIntegrityError,
  decryptRunFile,
  encryptRunFile,
  isEncryptedRunFile,
} from '@/lib/utils/shared/translation/nativeRunStorage';
import {
  StoredSourceTextRef,
  sourceTextFingerprint,
} from '@/lib/utils/shared/translation/storedSourceText';

/**
 * The browser's side of a stored source text (see storedSourceText.ts under
 * lib/utils/shared/translation): saving it, reading it back, keeping it
 * alive. A text is encrypted here, before it is sent, when this device
 * holds the person's backup key, and the server never sees that key or one
 * derived from it: unlike a formatted run, nothing on the server reads it.
 */

const ROUTE = '/api/workflows/translation/source-text';

type Place = Pick<StoredSourceTextRef, 'id' | 'backend' | 'keyId'>;

const urlOf = (place: Place): string =>
  `${ROUTE}?${new URLSearchParams({ id: place.id, storage: place.backend }).toString()}`;

/** A stored text is addressed like a run: its id is the folder. */
const accessOf = (place: Place): RunAccess => ({
  runId: place.id,
  backend: place.backend,
  ...(place.keyId ? { keyId: place.keyId } : {}),
});

const expiryOf = async (response: Response): Promise<string | undefined> => {
  const parsed = await response.json().catch(() => null);
  const expiresAt = parsed?.data?.expiresAt;
  return typeof expiresAt === 'string' ? expiresAt : undefined;
};

async function put(place: Place, text: string): Promise<StoredSourceTextRef> {
  const plain = new TextEncoder().encode(text);
  const key = await runKey(accessOf(place));
  const body = key
    ? await encryptRunFile(key, place.id, RUN_RECORD_ID, plain)
    : plain;
  const response = await fetch(urlOf(place), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(body),
  });
  if (!response.ok) throw await runErrorFrom(response, 'Storing failed');
  const expiresAt = await expiryOf(response);
  return {
    id: place.id,
    backend: place.backend,
    ...(place.keyId ? { keyId: place.keyId } : {}),
    fingerprint: sourceTextFingerprint(text),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * Saves a source text to storage.
 *
 * It goes where `previous` is, replacing that text, when there is one and
 * this device can write there; otherwise to a new place in `backend`,
 * encrypted when this device holds the backup key. A new text that cannot
 * use OneDrive goes to app storage instead.
 *
 * @param text - The text.
 * @param backend - Where a new text goes.
 * @param previous - The reference the text had, if any.
 * @returns The reference to keep.
 * @throws RunRequestError when storage refuses; the text then simply stays
 *   in the browser.
 */
export async function storeSourceText(
  text: string,
  backend: NativeRunBackend,
  previous?: StoredSourceTextRef,
): Promise<StoredSourceTextRef> {
  if (previous) {
    try {
      return await put(previous, text);
    } catch (error) {
      // A place this device cannot write to any more is left behind.
      const stuck =
        error instanceof RunLockedError || isOneDriveUnavailable(error);
      if (!stuck) throw error;
    }
  }
  const fresh = async (where: NativeRunBackend): Promise<Place> => {
    const access = await newRunAccess(where);
    return { id: access.runId, backend: where, keyId: access.keyId };
  };
  try {
    return await put(await fresh(backend), text);
  } catch (error) {
    if (backend !== 'onedrive' || !isOneDriveUnavailable(error)) throw error;
    return put(await fresh('app'), text);
  }
}

/**
 * Reads a stored source text.
 *
 * @throws RunMissingError when it is gone, RunLockedError when it is
 *   encrypted and this device cannot read it.
 */
export async function loadSourceText(
  ref: StoredSourceTextRef,
  signal?: AbortSignal,
): Promise<string> {
  // Checked first, so another device's key is named as the reason.
  const key = await runKey(accessOf(ref));
  const response = await fetch(urlOf(ref), { signal });
  if (!response.ok) throw await runErrorFrom(response, 'Loading failed');
  const stored = new Uint8Array(await response.arrayBuffer());
  if (!isEncryptedRunFile(stored)) return new TextDecoder().decode(stored);
  if (!key) throw new RunLockedError('no-key');
  try {
    return new TextDecoder().decode(
      await decryptRunFile(key, ref.id, RUN_RECORD_ID, stored),
    );
  } catch (error) {
    if (error instanceof RunFileIntegrityError) {
      throw new RunLockedError('other-key');
    }
    throw error;
  }
}

/**
 * Keeps a stored text from expiring, or only asks when it will.
 *
 * @param ref - The text.
 * @param touch - False only asks.
 * @returns When app storage deletes it; undefined on OneDrive.
 * @throws RunMissingError when the text is gone.
 */
export async function touchSourceText(
  ref: StoredSourceTextRef,
  touch = true,
): Promise<string | undefined> {
  const response = await fetch(urlOf(ref), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ touch }),
  });
  if (!response.ok) throw await runErrorFrom(response, 'Checking failed');
  return expiryOf(response);
}

/** Deletes a stored text; a failure is reported, not thrown. */
export async function deleteSourceText(
  ref: StoredSourceTextRef,
): Promise<boolean> {
  try {
    return (await fetch(urlOf(ref), { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

export { RunLockedError, RunMissingError };
