import { isDocumentTranslatableUpload } from '@/lib/constants/fileTypes';
import { describe, expect, it } from 'vitest';

describe('isDocumentTranslatableUpload', () => {
  it('accepts a file by its supported extension (no MIME needed)', () => {
    expect(isDocumentTranslatableUpload('report.docx')).toBe(true);
    expect(isDocumentTranslatableUpload('notes.txt', '')).toBe(true);
  });

  it('accepts a file whose extension is missing but MIME type is recognized', () => {
    expect(
      isDocumentTranslatableUpload(
        'report',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
  });

  it('normalizes a MIME type with a charset parameter', () => {
    expect(
      isDocumentTranslatableUpload('data', 'text/csv; charset=utf-8'),
    ).toBe(true);
  });

  it('rejects an unrecognized extension with no usable MIME type', () => {
    expect(isDocumentTranslatableUpload('archive.zip')).toBe(false);
    expect(
      isDocumentTranslatableUpload('archive.zip', 'application/octet-stream'),
    ).toBe(false);
    expect(isDocumentTranslatableUpload('archive.zip', null)).toBe(false);
  });
});
