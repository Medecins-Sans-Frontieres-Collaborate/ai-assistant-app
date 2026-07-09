import {
  isSafeBlobPathId,
  sanitizeBlobExtension,
} from '@/lib/utils/shared/blobPath';

import { describe, expect, it } from 'vitest';

describe('sanitizeBlobExtension', () => {
  it('keeps ordinary extensions, lowercased', () => {
    expect(sanitizeBlobExtension('pdf')).toBe('pdf');
    expect(sanitizeBlobExtension('PDF')).toBe('pdf');
    expect(sanitizeBlobExtension('docx')).toBe('docx');
  });

  it('strips traversal and separator payloads to a safe token', () => {
    // Each of these, interpolated raw into `${id}.${ext}`, could escape the
    // intended blob slot. After sanitizing, only [a-z0-9] survives.
    expect(sanitizeBlobExtension('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeBlobExtension('pdf/../../secret')).toBe('pdfsecret');
    expect(sanitizeBlobExtension('..')).toBe('bin'); // becomes empty → fallback
    expect(sanitizeBlobExtension('pdf?sig=abc')).toBe('pdfsigabc');
    expect(sanitizeBlobExtension('pdf%2f..')).toBe('pdf2f');
    expect(sanitizeBlobExtension('a\\b')).toBe('ab');
    expect(sanitizeBlobExtension('a.b')).toBe('ab');
  });

  it('never returns a value containing a path separator or dot', () => {
    for (const payload of [
      '../x',
      'a/b/c',
      'a\\b',
      '..%2f..%2f',
      'x.y.z',
      'a b',
    ]) {
      const result = sanitizeBlobExtension(payload);
      expect(result).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('applies the fallback for empty / null / all-stripped input', () => {
    expect(sanitizeBlobExtension('')).toBe('bin');
    expect(sanitizeBlobExtension(null)).toBe('bin');
    expect(sanitizeBlobExtension(undefined)).toBe('bin');
    expect(sanitizeBlobExtension('///', 'pdf')).toBe('pdf');
    expect(sanitizeBlobExtension('....', 'txt')).toBe('txt');
  });

  it('caps length', () => {
    expect(sanitizeBlobExtension('a'.repeat(100)).length).toBe(12);
  });
});

describe('isSafeBlobPathId', () => {
  it('accepts UUIDs', () => {
    expect(isSafeBlobPathId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
  });

  it('rejects anything path-shaped or non-UUID', () => {
    for (const bad of [
      '../../etc',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/../x',
      'not-a-uuid',
      '',
      '..',
      null,
      undefined,
    ]) {
      expect(isSafeBlobPathId(bad)).toBe(false);
    }
  });
});
