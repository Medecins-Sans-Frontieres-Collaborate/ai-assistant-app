import {
  MOUNTED_FILE_EXCERPT_MIN_TOKENS,
  MOUNTED_FILE_EXCERPT_TOKENS,
  buildMountedFileExcerpt,
  mountedExcerptTokens,
} from '@/lib/services/chat/processors/mountedFileExcerpt';

import { describe, expect, it } from 'vitest';

const rows = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `P2027-${String(i).padStart(4, '0')},Finance,1.0`,
  ).join('\n');

describe('mountedExcerptTokens', () => {
  it('uses the remaining budget between the floor and the cap', () => {
    expect(mountedExcerptTokens(2_500)).toBe(2_500);
    expect(mountedExcerptTokens(MOUNTED_FILE_EXCERPT_TOKENS)).toBe(
      MOUNTED_FILE_EXCERPT_TOKENS,
    );
    expect(mountedExcerptTokens(MOUNTED_FILE_EXCERPT_TOKENS + 1)).toBe(
      MOUNTED_FILE_EXCERPT_TOKENS,
    );
  });

  it('never goes below the floor, even with the budget spent', () => {
    expect(mountedExcerptTokens(-5_000)).toBe(MOUNTED_FILE_EXCERPT_MIN_TOKENS);
    expect(mountedExcerptTokens(MOUNTED_FILE_EXCERPT_MIN_TOKENS - 0.5)).toBe(
      MOUNTED_FILE_EXCERPT_MIN_TOKENS,
    );
  });
});

describe('buildMountedFileExcerpt', () => {
  it('returns text that already fits unchanged (boundary: exactly maxChars)', () => {
    const text = rows(10);
    expect(buildMountedFileExcerpt(text, 'WB27.xlsx', text.length)).toBe(text);
  });

  it('cuts one char over the limit at a row boundary and names the mounted file', () => {
    const text = rows(1_000);
    const excerpt = buildMountedFileExcerpt(text, 'WB27.xlsx', text.length - 1);
    const [notice, body] = excerpt.split('\n\n');
    expect(notice).toMatch(/^\[Excerpt of WB27\.xlsx/);
    expect(notice).toContain(
      'available to your code interpreter as "WB27.xlsx"',
    );
    expect(text.startsWith(body)).toBe(true);
    expect(body.endsWith('1.0')).toBe(true); // whole row, never split
    expect(body.length).toBeLessThan(text.length);
  });

  it('lists every sheet, since the opening rows only show the first', () => {
    const sheet = (name: string) =>
      `\n\n--- START OF SHEET: ${name} ---\n\n${rows(200)}\n\n--- END OF SHEET: ${name} ---\n\n`;
    const text = sheet('Summary') + sheet('Finance') + sheet('IT');
    const excerpt = buildMountedFileExcerpt(text, 'IB26.xlsx', 500);
    expect(excerpt).toContain('3 sheets: "Summary", "Finance", "IT"');
  });

  it('reports the shown share of the document', () => {
    const text = rows(1_000);
    const excerpt = buildMountedFileExcerpt(text, 'x.csv', text.length / 10);
    expect(excerpt).toMatch(/first ~[89]% of its extracted text/);
  });
});
