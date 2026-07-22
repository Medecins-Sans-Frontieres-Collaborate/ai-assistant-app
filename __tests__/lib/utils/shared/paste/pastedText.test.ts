import {
  DEFAULT_PASTE_ATTACHMENT_CHARS,
  PASTE_ATTACHMENT_MAX_CHARS,
  PASTE_ATTACHMENT_MIN_CHARS,
  buildPastedTextDocument,
  clampPasteAttachmentChars,
  pastedTextFileName,
  pastedTextHash,
  pastedTextTitle,
  shouldAttachPastedText,
} from '@/lib/utils/shared/paste/pastedText';

import { describe, expect, it } from 'vitest';

describe('clampPasteAttachmentChars', () => {
  it('keeps 0, which means the feature is off', () => {
    expect(clampPasteAttachmentChars(0)).toBe(0);
  });

  it('treats negatives as off rather than clamping them up to the minimum', () => {
    expect(clampPasteAttachmentChars(-1)).toBe(0);
  });

  it('pulls a too-small positive value up to the minimum', () => {
    expect(clampPasteAttachmentChars(10)).toBe(PASTE_ATTACHMENT_MIN_CHARS);
  });

  it('pulls a too-large value down to the maximum', () => {
    expect(clampPasteAttachmentChars(10_000_000)).toBe(
      PASTE_ATTACHMENT_MAX_CHARS,
    );
  });

  it('rounds fractional values', () => {
    expect(clampPasteAttachmentChars(2000.6)).toBe(2001);
  });

  it('falls back to the default for non-numbers, rather than disabling', () => {
    // A corrupt value must not silently turn the feature off — that would
    // read as "the feature is broken" rather than "the value was bad".
    expect(clampPasteAttachmentChars(undefined)).toBe(
      DEFAULT_PASTE_ATTACHMENT_CHARS,
    );
    expect(clampPasteAttachmentChars('2000')).toBe(
      DEFAULT_PASTE_ATTACHMENT_CHARS,
    );
    expect(clampPasteAttachmentChars(NaN)).toBe(DEFAULT_PASTE_ATTACHMENT_CHARS);
    expect(clampPasteAttachmentChars(Infinity)).toBe(
      DEFAULT_PASTE_ATTACHMENT_CHARS,
    );
  });
});

describe('shouldAttachPastedText', () => {
  it('is false at exactly the threshold and true one character past it', () => {
    expect(shouldAttachPastedText('x'.repeat(2000), 2000)).toBe(false);
    expect(shouldAttachPastedText('x'.repeat(2001), 2000)).toBe(true);
  });

  it('measures the trimmed length', () => {
    const padded = `${'x'.repeat(1999)}${' '.repeat(100)}`;
    expect(shouldAttachPastedText(padded, 2000)).toBe(false);
  });

  it('is always false when the threshold is 0', () => {
    expect(shouldAttachPastedText('x'.repeat(100_000), 0)).toBe(false);
  });

  it('applies the clamp, so a bogus threshold still behaves sanely', () => {
    // 10 clamps up to the 500 minimum, so a 100-char paste stays inline.
    expect(shouldAttachPastedText('x'.repeat(100), 10)).toBe(false);
    expect(shouldAttachPastedText('x'.repeat(600), 10)).toBe(true);
  });

  it('is false for empty and whitespace-only text', () => {
    expect(shouldAttachPastedText('', 500)).toBe(false);
    expect(shouldAttachPastedText('   \n  ', 500)).toBe(false);
  });
});

describe('pastedTextTitle', () => {
  it('uses the first non-empty line', () => {
    expect(pastedTextTitle('\n\n  Quarterly results  \nbody', 'fallback')).toBe(
      'Quarterly results',
    );
  });

  it('strips markdown heading markers', () => {
    expect(pastedTextTitle('## Budget notes\nbody', 'fallback')).toBe(
      'Budget notes',
    );
  });

  it('strips characters that are unsafe in a filename', () => {
    expect(pastedTextTitle('a/b:c*d?e"f<g>h|i', 'fallback')).toBe(
      'a-b-c-d-e-f-g-h-i',
    );
  });

  it('collapses runs of whitespace', () => {
    expect(pastedTextTitle('too    many     spaces', 'fallback')).toBe(
      'too many spaces',
    );
  });

  it('truncates to 60 characters without leaving a trailing separator', () => {
    const title = pastedTextTitle('w '.repeat(80), 'fallback');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).not.toMatch(/[-\s]$/);
  });

  it('falls back when there is no usable text', () => {
    expect(pastedTextTitle('   \n  ', 'Pasted text')).toBe('Pasted text');
    expect(pastedTextTitle('###', 'Pasted text')).toBe('Pasted text');
  });
});

describe('pastedTextFileName', () => {
  it('is deterministic, so the same paste twice reads as a repeat', () => {
    const text = 'Some pasted content';
    expect(pastedTextFileName(text, 'Pasted text')).toBe(
      pastedTextFileName(text, 'Pasted text'),
    );
  });

  it('distinguishes different pastes that share an opening line', () => {
    const a = pastedTextFileName('Report\nfirst body', 'Pasted text');
    const b = pastedTextFileName('Report\nsecond body', 'Pasted text');
    expect(a).not.toBe(b);
  });

  it('ends in .md', () => {
    expect(pastedTextFileName('hello', 'Pasted text')).toMatch(/\.md$/);
  });
});

describe('pastedTextHash', () => {
  it('is stable and differs for different input', () => {
    expect(pastedTextHash('abc')).toBe(pastedTextHash('abc'));
    expect(pastedTextHash('abc')).not.toBe(pastedTextHash('abd'));
  });
});

describe('buildPastedTextDocument', () => {
  const copy = { heading: 'Pasted text', pastedLabel: 'Pasted' };
  const now = new Date('2026-07-18T12:00:00.000Z');

  it('puts the content after a rule, with a heading and timestamp above', () => {
    expect(buildPastedTextDocument('the body', copy, now)).toBe(
      '# Pasted text\n\nPasted: 2026-07-18T12:00:00.000Z\n\n---\n\nthe body\n',
    );
  });

  it('trims the content but preserves its internal structure', () => {
    const doc = buildPastedTextDocument(
      '\n\nline one\n\nline two\n\n',
      copy,
      now,
    );
    expect(doc.endsWith('line one\n\nline two\n')).toBe(true);
  });
});
