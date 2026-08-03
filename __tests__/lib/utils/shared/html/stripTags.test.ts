import {
  htmlToPlainTextFragment,
  stripHtmlNoise,
  stripHtmlTags,
} from '@/lib/utils/shared/html/stripTags';

import { describe, expect, it } from 'vitest';

describe('stripHtmlTags', () => {
  it('removes ordinary tags', () => {
    expect(stripHtmlTags('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('does not let a SPLIT tag reconstruct (the single-pass bypass)', () => {
    // One pass removes <v> and leaves "<script>alert(1)</script>".
    expect(
      htmlToPlainTextFragment('<scr<v>ipt>alert(1)</scr<v>ipt>'),
    ).not.toContain('<script');
    expect(
      htmlToPlainTextFragment('<<a>img src=x onerror=alert(1)>'),
    ).not.toContain('<img');
  });

  it('drops a dangling unterminated tag at the end of input', () => {
    expect(stripHtmlTags('text <script src=evil')).toBe('text ');
    expect(stripHtmlTags('done </div')).toBe('done ');
  });

  it('leaves ordinary prose containing "<" alone', () => {
    expect(stripHtmlTags('5 < 6 and 7 > 2')).toBe('5 < 6 and 7 > 2');
  });
});

describe('stripHtmlNoise', () => {
  it('removes script and style elements with their contents', () => {
    expect(htmlToPlainTextFragment('a<script>var x = "<b>";</script>b')).toBe(
      'a b',
    );
    expect(htmlToPlainTextFragment('a<style>.x{color:red}</style>b')).toBe(
      'a b',
    );
  });

  it('honours the --!> comment end form browsers accept', () => {
    // A `-->`-only regex walks past this end tag and swallows the rest.
    const out = htmlToPlainTextFragment('before<!-- hidden --!>after');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('hidden');
  });

  it('treats an unterminated comment or script as running to the end', () => {
    // Noise collapses to a separating space, hence the trim.
    expect(htmlToPlainTextFragment('keep<!-- rest is dead').trim()).toBe(
      'keep',
    );
    expect(htmlToPlainTextFragment('keep<script>alert(1)').trim()).toBe('keep');
  });

  it('is stable on input with no HTML at all', () => {
    expect(stripHtmlNoise('plain text')).toBe('plain text');
    expect(htmlToPlainTextFragment('plain text')).toBe('plain text');
  });
});
