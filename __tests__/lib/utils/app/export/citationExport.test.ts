import {
  appendCitationsToMarkdown,
  formatCitationsAsMarkdown,
} from '@/lib/utils/app/export/citationExport';

import { Citation } from '@/types/rag';

import { describe, expect, it } from 'vitest';

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    title: 'Example Title',
    date: '2026-01-15',
    url: 'https://example.com/article',
    number: 1,
    ...overrides,
  };
}

describe('formatCitationsAsMarkdown', () => {
  it('formats a single citation with heading, link, and date', () => {
    const result = formatCitationsAsMarkdown([citation()]);

    expect(result).toBe(
      '## Sources\n\n1. [Example Title](https://example.com/article) — 2026-01-15',
    );
  });

  it('numbers entries by array position, not the citation number field', () => {
    const result = formatCitationsAsMarkdown([
      citation({ title: 'First', number: 7 }),
      citation({ title: 'Second', url: 'https://example.com/b', number: 3 }),
    ]);

    expect(result).toContain('1. [First]');
    expect(result).toContain('2. [Second]');
  });

  it('does not collapse duplicate citations so positions stay aligned with inline markers', () => {
    const result = formatCitationsAsMarkdown([
      citation({ title: 'Same' }),
      citation({ title: 'Same' }),
      citation({ title: 'Other', url: 'https://example.com/other' }),
    ]);

    expect(result).toContain('1. [Same]');
    expect(result).toContain('2. [Same]');
    expect(result).toContain('3. [Other]');
  });

  it('falls back to the url as link text when the title is empty', () => {
    const result = formatCitationsAsMarkdown([citation({ title: '' })]);

    expect(result).toContain(
      '1. [https://example.com/article](https://example.com/article)',
    );
  });

  it('renders plain text without link syntax when the url is empty', () => {
    const result = formatCitationsAsMarkdown([citation({ url: '' })]);

    expect(result).toContain('1. Example Title — 2026-01-15');
    expect(result).not.toContain('](');
  });

  it('omits the date suffix when the date is empty', () => {
    const result = formatCitationsAsMarkdown([citation({ date: '' })]);

    expect(result).toContain('1. [Example Title](https://example.com/article)');
    expect(result).not.toContain('—');
  });

  it('escapes markdown brackets and backslashes in titles', () => {
    const result = formatCitationsAsMarkdown([
      citation({ title: 'A [bracketed] \\ title' }),
    ]);

    expect(result).toContain('1. [A \\[bracketed\\] \\\\ title]');
  });

  it('percent-encodes parentheses and spaces in urls and tolerates malformed urls', () => {
    const result = formatCitationsAsMarkdown([
      citation({ url: 'https://example.com/a (1) b' }),
      citation({ title: 'Odd', url: 'not a url' }),
    ]);

    expect(result).toContain('(https://example.com/a%20%281%29%20b)');
    expect(result).toContain('2. [Odd](not%20a%20url)');
  });

  it('returns an empty string for an empty array', () => {
    expect(formatCitationsAsMarkdown([])).toBe('');
  });

  it('uses a custom heading when provided', () => {
    const result = formatCitationsAsMarkdown([citation()], 'Quellen');

    expect(result).toContain('## Quellen');
    expect(result).not.toContain('## Sources');
  });
});

describe('appendCitationsToMarkdown', () => {
  it('appends the sources section after a thematic break', () => {
    const result = appendCitationsToMarkdown('Body text.', [citation()]);

    expect(result).toBe(
      'Body text.\n\n---\n\n## Sources\n\n1. [Example Title](https://example.com/article) — 2026-01-15\n',
    );
  });

  it('trims trailing whitespace from the body before appending', () => {
    const result = appendCitationsToMarkdown('Body text.\n\n', [citation()]);

    expect(result.startsWith('Body text.\n\n---\n\n')).toBe(true);
  });

  it('returns the content unchanged when there are no citations', () => {
    expect(appendCitationsToMarkdown('Body text.\n', [])).toBe('Body text.\n');
  });

  it('passes the heading through to the formatted section', () => {
    const result = appendCitationsToMarkdown('Body', [citation()], 'Fuentes');

    expect(result).toContain('## Fuentes');
  });
});
