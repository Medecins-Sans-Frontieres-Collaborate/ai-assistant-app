import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { describe, expect, it } from 'vitest';

/**
 * Claim-level citation quotes (M365 agents): the model appends a
 * <<<CITATION_QUOTES>>> block after its answer; the server ships the
 * retrieved chunk texts in a terminal metadata block. The parser must keep
 * the wire format out of the rendered text, verify each claimed quote is a
 * verbatim substring of its cited chunk, and only then surface it on the
 * citation — a failed verification keeps the extractive fallback quote.
 */

function feed(parser: StreamParser, text: string) {
  parser.processChunk(new TextEncoder().encode(text));
}

const CHUNK_1 =
  'Employees accrue three paid personal days per calendar year. Personal days do not roll over.';
const CHUNK_2 = 'Sick leave is unlimited but requires a note after 3 days.';

const citationsBlock = `\n\n<<<METADATA_START>>>${JSON.stringify({
  citations: [
    {
      title: 'Employee Handbook',
      date: '',
      url: 'https://contoso.sharepoint.com/handbook.pdf',
      number: 1,
      quote: 'extractive caption 1',
    },
    {
      title: 'Employee Handbook',
      date: '',
      url: 'https://contoso.sharepoint.com/handbook.pdf',
      number: 2,
      quote: 'extractive caption 2',
    },
  ],
})}<<<METADATA_END>>>`;

const quoteSourcesBlock = `\n\n<<<METADATA_START>>>${JSON.stringify({
  citationQuoteSources: { '1': CHUNK_1, '2': CHUNK_2 },
})}<<<METADATA_END>>>`;

function quotesBlock(quotes: Record<string, string>): string {
  return `\n\n<<<CITATION_QUOTES>>>${JSON.stringify(quotes)}<<<END_CITATION_QUOTES>>>`;
}

describe('StreamParser citation-quote verification', () => {
  it('replaces the fallback quote with a verified claim quote', () => {
    const parser = new StreamParser();
    feed(parser, 'You get three personal days [1].');
    feed(
      parser,
      quotesBlock({
        '1': 'Employees accrue three paid personal days per calendar year.',
        '2': 'This sentence is NOT in chunk two.',
      }),
    );
    feed(parser, citationsBlock);
    feed(parser, quoteSourcesBlock);
    parser.finalize();

    const citations = parser.getCitations();
    // [1] verified — model quote replaces the extractive caption.
    expect(citations[0].quote).toBe(
      'Employees accrue three paid personal days per calendar year.',
    );
    // [2] failed verification — extractive fallback stays.
    expect(citations[1].quote).toBe('extractive caption 2');
  });

  it('tolerates typographic quote/whitespace drift in verification', () => {
    const parser = new StreamParser();
    feed(parser, 'answer [2]');
    feed(
      parser,
      quotesBlock({
        '2': 'Sick  leave is unlimited but requires a note after 3 days.',
      }),
    );
    feed(parser, citationsBlock);
    feed(parser, quoteSourcesBlock);

    expect(parser.getCitations()[1].quote).toBe(
      'Sick  leave is unlimited but requires a note after 3 days.',
    );
  });

  it('keeps the quotes block out of the rendered text, even split across reads', () => {
    const parser = new StreamParser();
    feed(parser, 'The policy is three days [1].');
    const block = quotesBlock({ '1': 'Employees accrue three paid' });
    // Split mid-marker and mid-JSON across network reads.
    feed(parser, block.slice(0, 12));
    feed(parser, block.slice(12, 40));
    feed(parser, block.slice(40));
    feed(parser, citationsBlock);

    expect(parser.finalize()).toBe('The policy is three days [1].');
  });

  it('drops a mangled quotes block and keeps fallback quotes', () => {
    const parser = new StreamParser();
    feed(parser, 'answer [1]');
    feed(
      parser,
      '\n\n<<<CITATION_QUOTES>>>{not valid json<<<END_CITATION_QUOTES>>>',
    );
    feed(parser, citationsBlock);
    feed(parser, quoteSourcesBlock);

    expect(parser.finalize()).toBe('answer');
    expect(parser.getCitations()[0].quote).toBe('extractive caption 1');
  });

  it('never exposes chunk texts on the citations it returns', () => {
    const parser = new StreamParser();
    feed(parser, 'answer [1]');
    feed(parser, citationsBlock);
    feed(parser, quoteSourcesBlock);

    const serialized = JSON.stringify(parser.getCitations());
    expect(serialized).not.toContain('Sick leave is unlimited');
  });
});
