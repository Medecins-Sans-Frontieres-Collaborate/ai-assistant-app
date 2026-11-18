/**
 * When a translation's source text is kept out of the browser, and how the
 * browser knows.
 *
 * THE BUDGET. Conversations are kept in localStorage, which holds about
 * {@link LOCAL_STORAGE_QUOTA_CHARS} characters for the whole app (less in
 * Safari). A translation keeps its source, its translation (about as long
 * again) and the review around both: roughly
 * {@link TRANSLATION_STATE_PER_SOURCE_CHAR} characters per source
 * character. One translation is a substantial share of the quota when it
 * alone takes {@link SUBSTANTIAL_QUOTA_SHARE} of it, which is a source of
 * {@link STORED_SOURCE_TEXT_MIN_CHARS} characters: about seven pages. A
 * hundred such translations would fill the browser with nothing else in
 * it. Shorter texts stay where they are: storing them saves little and
 * costs a round trip each time the conversation is opened.
 *
 * CONVENTIONS (stated once; the workspace hook and the persistence step
 * both cite these)
 *  - In memory, workflow state always holds the text itself, in
 *    `sourceText`. Nothing that reads it needs to know about storage.
 *  - A text of STORED_SOURCE_TEXT_MIN_CHARS or more is also saved to
 *    storage, and `sourceTextRef` then names where. The reference is
 *    CURRENT only while its `fingerprint` is that of `sourceText`: an
 *    edited text makes it stale until it is saved again.
 *  - What is written to localStorage is {@link detachSourceText} of the
 *    state: with a current reference the text is left out and the
 *    reference marked `detached`. A stale or absent reference keeps the
 *    text in the browser, so nothing is ever only in memory.
 *  - A `detached` reference in memory means the text has not been fetched
 *    yet. Only then is an empty `sourceText` not the person's doing.
 *  - The stored text lives under the rules of nativeRunStorage.ts: the
 *    same two places, the same expiry in app storage, the same encryption.
 */
import { NativeRunBackend, isRunBackend, isRunId } from './nativeRunStorage';

/** Characters localStorage holds per site in most browsers. */
export const LOCAL_STORAGE_QUOTA_CHARS = 5_000_000;
/** Share of the quota at which one translation counts as substantial. */
export const SUBSTANTIAL_QUOTA_SHARE = 0.01;
/** Characters a translation keeps in all, per character of its source. */
export const TRANSLATION_STATE_PER_SOURCE_CHAR = 2.5;
/** Source length from which the text is kept in storage, not the browser. */
export const STORED_SOURCE_TEXT_MIN_CHARS = Math.round(
  (LOCAL_STORAGE_QUOTA_CHARS * SUBSTANTIAL_QUOTA_SHARE) /
    TRANSLATION_STATE_PER_SOURCE_CHAR,
);
/** Largest stored text the server accepts, in bytes. */
export const STORED_SOURCE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Where a source text is stored, and which text it is. */
export interface StoredSourceTextRef {
  /** The text's folder in storage (a UUID), kept across edits. */
  id: string;
  backend: NativeRunBackend;
  /** Fingerprint of the backup key the text is encrypted under, if it is. */
  keyId?: string;
  /** {@link sourceTextFingerprint} of the text that was stored. */
  fingerprint: string;
  /** ISO time app storage deletes the text unless touched; absent on OneDrive. */
  expiresAt?: string;
  /** The text is not in `sourceText`: it has to be fetched. */
  detached?: boolean;
}

/** The part of workflow state these rules apply to. */
export interface SourceTextHolder {
  sourceText: string;
  sourceTextRef?: StoredSourceTextRef;
}

/** Whether a text is long enough to be kept in storage. */
export function isLargeSourceText(text: string): boolean {
  return text.length >= STORED_SOURCE_TEXT_MIN_CHARS;
}

/**
 * A short, fast fingerprint of a text (its length and an FNV-1a hash). It
 * tells an edited text from the stored one; it is not a security measure.
 */
export function sourceTextFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** Whether a value is a usable reference. */
export function isStoredSourceTextRef(
  value: unknown,
): value is StoredSourceTextRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return (
    isRunId(ref.id) &&
    isRunBackend(ref.backend) &&
    typeof ref.fingerprint === 'string'
  );
}

/**
 * Whether the stored text is the one in memory, so the browser's copy can
 * be left out.
 */
export function hasCurrentSourceTextRef(state: SourceTextHolder): boolean {
  const ref = state.sourceTextRef;
  return (
    !!ref &&
    !ref.detached &&
    ref.fingerprint === sourceTextFingerprint(state.sourceText)
  );
}

/**
 * The state as it is written to the browser: without the text when storage
 * holds it. Anything else is returned as it is.
 */
export function detachSourceText<T extends SourceTextHolder>(state: T): T {
  if (!hasCurrentSourceTextRef(state) || !state.sourceTextRef) return state;
  return {
    ...state,
    sourceText: '',
    sourceTextRef: { ...state.sourceTextRef, detached: true },
  };
}

/**
 * The state once its text has been fetched.
 *
 * @param state - A state whose reference is `detached`.
 * @param text - The text storage returned.
 */
export function attachSourceText<T extends SourceTextHolder>(
  state: T,
  text: string,
): T {
  if (!state.sourceTextRef) return state;
  const { detached: _detached, ...ref } = state.sourceTextRef;
  return {
    ...state,
    sourceText: text,
    sourceTextRef: { ...ref, fingerprint: sourceTextFingerprint(text) },
  };
}
