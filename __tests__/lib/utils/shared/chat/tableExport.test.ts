import {
  tableRowsToCsv,
  tableRowsToHtml,
  tableRowsToMarkdown,
  tableRowsToTsv,
} from '@/lib/utils/shared/chat/tableExport';

import { describe, expect, it } from 'vitest';

describe('tableRowsToCsv', () => {
  it('joins cells with commas and rows with CRLF', () => {
    expect(
      tableRowsToCsv([
        ['Name', 'Age'],
        ['Ada', '36'],
      ]),
    ).toBe('Name,Age\r\nAda,36');
  });

  it('quotes fields containing commas, quotes, or newlines', () => {
    expect(
      tableRowsToCsv([
        ['a,b', 'say "hi"'],
        ['line1\nline2', 'plain'],
      ]),
    ).toBe('"a,b","say ""hi"""\r\n"line1\nline2",plain');
  });

  it('returns an empty string for no rows', () => {
    expect(tableRowsToCsv([])).toBe('');
  });
});

describe('tableRowsToTsv', () => {
  it('joins cells with tabs and collapses embedded tabs/newlines', () => {
    expect(
      tableRowsToTsv([
        ['Name', 'Note'],
        ['Ada', 'has\ttab and\nnewline'],
      ]),
    ).toBe('Name\tNote\nAda\thas tab and newline');
  });
});

describe('tableRowsToMarkdown', () => {
  it('renders a GFM table with a separator after the header row', () => {
    expect(
      tableRowsToMarkdown([
        ['Name', 'Age'],
        ['Ada', '36'],
      ]),
    ).toBe('| Name | Age |\n| --- | --- |\n| Ada | 36 |');
  });

  it('escapes pipes and converts newlines to <br>', () => {
    expect(tableRowsToMarkdown([['a|b'], ['x\ny']])).toBe(
      '| a\\|b |\n| --- |\n| x<br>y |',
    );
  });

  it('pads ragged rows to the widest row', () => {
    expect(tableRowsToMarkdown([['A', 'B'], ['only-one']])).toBe(
      '| A | B |\n| --- | --- |\n| only-one |  |',
    );
  });

  it('returns an empty string for no rows or empty rows', () => {
    expect(tableRowsToMarkdown([])).toBe('');
    expect(tableRowsToMarkdown([[]])).toBe('');
  });
});

describe('tableRowsToHtml', () => {
  it('renders header cells as <th> and body cells as <td>', () => {
    const html = tableRowsToHtml([
      ['Name', 'Age'],
      ['Ada', '36'],
    ]);
    expect(html).toContain('<thead><tr><th');
    expect(html).toContain('>Name</th>');
    expect(html).toContain('<tbody><tr><td');
    expect(html).toContain('>Ada</td>');
  });

  it('escapes HTML in cell content', () => {
    const html = tableRowsToHtml([['<script>&"']]);
    expect(html).toContain('&lt;script&gt;&amp;&quot;');
    expect(html).not.toContain('<script>');
  });

  it('omits tbody when there are no body rows', () => {
    expect(tableRowsToHtml([['only-header']])).not.toContain('<tbody>');
  });

  it('returns an empty string for no rows', () => {
    expect(tableRowsToHtml([])).toBe('');
  });
});
