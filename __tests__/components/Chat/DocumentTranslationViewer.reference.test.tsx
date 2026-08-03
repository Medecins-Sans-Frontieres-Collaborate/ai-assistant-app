// @vitest-environment jsdom

/**
 * The translation marker's optional M365 src segment: round-trip through
 * format/parse, and backward compatibility with pre-existing markers.
 */
import {
  formatTranslationReference,
  isDocumentTranslationReference,
  parseTranslationReference,
} from '@/components/Chat/DocumentTranslationViewer';

import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

const EXPIRES = '2026-08-07T12:00:00.000Z';

describe('translation reference marker', () => {
  it('round-trips a marker without an M365 source (legacy shape)', () => {
    const marker = formatTranslationReference(
      'report_fr.docx',
      'fr',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'docx',
      EXPIRES,
    );
    expect(marker).toBe(
      '[Translation: report_fr.docx | lang:fr | blob:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee | ext:docx | expires:2026-08-07T12:00:00.000Z]',
    );
    const parsed = parseTranslationReference(marker);
    expect(parsed?.filename).toBe('report_fr.docx');
    expect(parsed?.m365Source).toBeUndefined();
  });

  it('round-trips a marker with an M365 source folder', () => {
    const marker = formatTranslationReference(
      'report_fr.docx',
      'fr',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'docx',
      EXPIRES,
      { driveId: 'b!x_Y=,z-1', parentItemId: '01ABCDEF.GH,IJ' },
    );
    expect(isDocumentTranslationReference(marker)).toBe(true);
    const parsed = parseTranslationReference(marker);
    expect(parsed?.m365Source).toEqual({
      driveId: 'b!x_Y=,z-1',
      parentItemId: '01ABCDEF.GH,IJ',
    });
  });

  it('still recognises markers written before the src segment existed', () => {
    const legacy =
      '[Translation: notes_es.txt | lang:es | blob:11111111-2222-3333-4444-555555555555 | ext:txt | expires:2026-08-01T00:00:00.000Z]';
    expect(isDocumentTranslationReference(legacy)).toBe(true);
    expect(parseTranslationReference(legacy)?.filename).toBe('notes_es.txt');
  });
});
