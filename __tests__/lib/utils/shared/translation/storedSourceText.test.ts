import {
  LOCAL_STORAGE_QUOTA_CHARS,
  STORED_SOURCE_TEXT_MIN_CHARS,
  StoredSourceTextRef,
  TRANSLATION_STATE_PER_SOURCE_CHAR,
  attachSourceText,
  detachSourceText,
  hasCurrentSourceTextRef,
  isLargeSourceText,
  isStoredSourceTextRef,
  sourceTextFingerprint,
} from '@/lib/utils/shared/translation/storedSourceText';

import { describe, expect, it } from 'vitest';

const ID = '11111111-2222-4333-8444-555555555555';
const refFor = (
  text: string,
  extra: Partial<StoredSourceTextRef> = {},
): StoredSourceTextRef => ({
  id: ID,
  backend: 'app',
  fingerprint: sourceTextFingerprint(text),
  ...extra,
});

describe('how large is large', () => {
  it('is the source at which one translation takes a hundredth of the browser', () => {
    expect(STORED_SOURCE_TEXT_MIN_CHARS).toBe(20_000);
    const whole =
      STORED_SOURCE_TEXT_MIN_CHARS * TRANSLATION_STATE_PER_SOURCE_CHAR;
    expect(whole / LOCAL_STORAGE_QUOTA_CHARS).toBeCloseTo(0.01, 6);
  });

  it('starts exactly at the threshold', () => {
    expect(isLargeSourceText('a'.repeat(STORED_SOURCE_TEXT_MIN_CHARS))).toBe(
      true,
    );
    expect(
      isLargeSourceText('a'.repeat(STORED_SOURCE_TEXT_MIN_CHARS - 1)),
    ).toBe(false);
  });
});

describe('fingerprints', () => {
  it('tell an edited text from the stored one', () => {
    const text = 'Rapport annuel '.repeat(2000);
    expect(sourceTextFingerprint(text)).toBe(sourceTextFingerprint(text));
    // Same length, one character changed.
    expect(sourceTextFingerprint(text.replace('R', 'r'))).not.toBe(
      sourceTextFingerprint(text),
    );
    expect(sourceTextFingerprint(`${text} `)).not.toBe(
      sourceTextFingerprint(text),
    );
    expect(sourceTextFingerprint('')).toBe('0:811c9dc5');
  });
});

describe('what the browser is given to keep', () => {
  const text = 'x'.repeat(30_000);

  it('leaves the text out when storage holds it', () => {
    const state = { sourceText: text, sourceTextRef: refFor(text), other: 1 };
    const kept = detachSourceText(state);
    expect(kept.sourceText).toBe('');
    expect(kept.sourceTextRef).toEqual({ ...refFor(text), detached: true });
    expect(kept.other).toBe(1);
    // The state in memory is not changed.
    expect(state.sourceText).toBe(text);
  });

  it('keeps the text when storage holds an older one, or none', () => {
    const stale = { sourceText: `${text}!`, sourceTextRef: refFor(text) };
    expect(detachSourceText(stale)).toBe(stale);
    expect(hasCurrentSourceTextRef(stale)).toBe(false);
    const none = { sourceText: text };
    expect(detachSourceText(none)).toBe(none);
  });

  it('writes a text that has not been fetched back as it is', () => {
    const waiting = {
      sourceText: '',
      sourceTextRef: refFor(text, { detached: true }),
    };
    expect(detachSourceText(waiting)).toBe(waiting);
    expect(hasCurrentSourceTextRef(waiting)).toBe(false);
  });

  it('puts a fetched text back, and is then current again', () => {
    const waiting = {
      sourceText: '',
      sourceTextRef: refFor('older text', { detached: true }),
    };
    const loaded = attachSourceText(waiting, text);
    expect(loaded.sourceText).toBe(text);
    expect(loaded.sourceTextRef?.detached).toBeUndefined();
    expect(hasCurrentSourceTextRef(loaded)).toBe(true);
    // Round trip: what is written again is what was read.
    expect(detachSourceText(loaded).sourceTextRef).toEqual({
      ...refFor(text),
      detached: true,
    });
  });

  it('recognises a reference', () => {
    expect(isStoredSourceTextRef(refFor('a'))).toBe(true);
    expect(isStoredSourceTextRef({ ...refFor('a'), id: '../x' })).toBe(false);
    expect(isStoredSourceTextRef({ ...refFor('a'), backend: 'ftp' })).toBe(
      false,
    );
    expect(isStoredSourceTextRef(null)).toBe(false);
  });
});
