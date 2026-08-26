import {
  INDEXABLE_EXTENSIONS,
  checkDocumentSignature,
  detectDocumentContainer,
} from '@/lib/services/m365/documentSignature';

import { describe, expect, it } from 'vitest';

const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj', 'latin1');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1');
const text = Buffer.from('# Handbook\n\nWelcome to the team.', 'utf8');

describe('detectDocumentContainer', () => {
  it('recognises the document containers the extractors accept', () => {
    expect(detectDocumentContainer(pdf)).toBe('pdf');
    expect(detectDocumentContainer(zip)).toBe('zip');
    expect(detectDocumentContainer(ole)).toBe('ole');
    expect(detectDocumentContainer(Buffer.from('{\\rtf1\\ansi'))).toBe('rtf');
    expect(detectDocumentContainer(text)).toBe('text');
  });

  it('treats binaries with NUL bytes as unrecognised', () => {
    expect(detectDocumentContainer(exe)).toBeUndefined();
  });
});

describe('checkDocumentSignature', () => {
  it('accepts bytes that match the extension', () => {
    expect(checkDocumentSignature(pdf, 'pdf').ok).toBe(true);
    expect(checkDocumentSignature(zip, 'docx').ok).toBe(true);
    expect(checkDocumentSignature(zip, 'pptx').ok).toBe(true);
    expect(checkDocumentSignature(ole, 'doc').ok).toBe(true);
    expect(checkDocumentSignature(text, 'md').ok).toBe(true);
    expect(checkDocumentSignature(text, 'CSV').ok).toBe(true);
  });

  it('rejects a renamed executable and a mislabeled container', () => {
    const renamed = checkDocumentSignature(exe, 'docx');
    expect(renamed.ok).toBe(false);
    expect(renamed.error).toMatch(/does not look like a \.docx/);
    // A zip claiming to be a PDF is exactly the pandoc/pdfjs mismatch we
    // want to refuse before extraction.
    expect(checkDocumentSignature(zip, 'pdf').ok).toBe(false);
    // A "text" file that is actually a binary blob.
    expect(checkDocumentSignature(exe, 'txt').ok).toBe(false);
  });

  it('fails closed for unknown extensions and empty files', () => {
    expect(checkDocumentSignature(pdf, 'mp4').ok).toBe(false);
    expect(checkDocumentSignature(Buffer.alloc(0), 'pdf').ok).toBe(false);
  });

  it('exposes the indexable extension set the planner gates on', () => {
    for (const ext of ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'epub']) {
      expect(INDEXABLE_EXTENSIONS.has(ext)).toBe(true);
    }
    for (const ext of ['mp4', 'png', 'zip', 'exe', 'svg']) {
      expect(INDEXABLE_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});
