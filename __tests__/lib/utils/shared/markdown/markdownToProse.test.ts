import {
  hasMarkdownEscapes,
  markdownToProse,
} from '@/lib/utils/shared/markdown/markdownToProse';

import { describe, expect, it } from 'vitest';

describe('markdownToProse', () => {
  it('removes the escapes Turndown adds, which is what the page said', () => {
    expect(
      markdownToProse(
        'In Ituri \\[province\\], the original outbreak is 5\\* worse',
      ),
    ).toBe('In Ituri [province], the original outbreak is 5* worse');
    expect(markdownToProse('first\\_last@msf.org and a\\\\b')).toBe(
      'first_last@msf.org and a\\b',
    );
    expect(markdownToProse('\\#Ebola is trending\n2024\\. It was.')).toBe(
      '#Ebola is trending\n2024. It was.',
    );
  });

  it('drops headings, bullets, quotes and rules but keeps paragraphs', () => {
    const md = [
      '## A heading ##',
      '',
      '> Quoted line',
      '',
      '- one',
      '* two',
      '3. three',
      '',
      '---',
      '',
      'Last paragraph.',
    ].join('\n');
    expect(markdownToProse(md)).toBe(
      'A heading\n\nQuoted line\n\none\ntwo\nthree\n\nLast paragraph.',
    );
  });

  it('unwraps emphasis, code and links to their words', () => {
    expect(
      markdownToProse(
        '**Bold** and _em_ and *em* and `code` and [text](https://x.y) ![alt](i.png)',
      ),
    ).toBe('Bold and em and em and code and text alt');
    // Underscores inside words are not emphasis.
    expect(markdownToProse('snake_case_name stays')).toBe(
      'snake_case_name stays',
    );
  });

  it('flattens a table to its cells', () => {
    const md = '| Country | Cases |\n|---|---|\n| DRC | 1,200 |';
    expect(markdownToProse(md)).toBe('Country  Cases\n\nDRC  1,200');
  });

  it('keeps fenced code as text and is idempotent', () => {
    const md = '```\nx \\[1\\]\n```\nAfter.';
    const once = markdownToProse(md);
    expect(once).toBe('x [1]\nAfter.');
    expect(markdownToProse(once)).toBe(once);
    const prose = 'Plain prose with [brackets], 3.5 million, a-b and 50%.';
    expect(markdownToProse(prose)).toBe(prose);
  });

  it('knows a text saved before the fix', () => {
    expect(hasMarkdownEscapes('In \\[province\\]')).toBe(true);
    expect(hasMarkdownEscapes('In [province]')).toBe(false);
  });
});

describe('a draft saved with Markdown escapes', () => {
  it('still verifies, links to the page, and is repaired on load', async () => {
    const { locateExcerpt } =
      await import('@/lib/utils/shared/drafter/core/verify');
    const { buildTextFragmentUrl } =
      await import('@/lib/utils/shared/drafter/core/textFragment');
    const { emptyBrief, unescapeMarkdownInBrief } =
      await import('@/lib/utils/shared/drafter/core/brief');
    const escaped = 'In Ituri \\[province\\], the original outbreak';
    const page = 'In Ituri [province], the original outbreak';
    // An old excerpt against a new prose source, and a clean quote against
    // an old Markdown source: both are the same words.
    expect(locateExcerpt(page, escaped)).not.toBeNull();
    expect(locateExcerpt(escaped, page)).not.toBeNull();
    // The link carries the page's characters, never a backslash.
    expect(buildTextFragmentUrl('https://example.org/a', page)).toBe(
      'https://example.org/a#:~:text=In%20Ituri%20%5Bprovince%5D%2C%20the%20original%20outbreak',
    );
    const brief = {
      ...emptyBrief(),
      items: [
        {
          id: 'i1',
          kind: 'fact' as const,
          text: escaped,
          provenance: [{ sourceId: 's', excerpt: escaped }],
          verified: 'verbatim' as const,
        },
      ],
    };
    const repaired = unescapeMarkdownInBrief(brief);
    expect(repaired.items[0].text).toBe(page);
    expect(repaired.items[0].provenance[0].excerpt).toBe(page);
    expect(unescapeMarkdownInBrief(repaired)).toBe(repaired);
  });
});
