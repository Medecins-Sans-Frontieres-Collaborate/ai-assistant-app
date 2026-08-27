/**
 * @vitest-environment jsdom
 */
import { clipboardHtmlToMarkdown } from '@/client/services/paste/clipboardHtml';

import { describe, expect, it } from 'vitest';

// Trimmed-down shape of what Word for Mac puts in `text/html`.
const WORD_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta name="Generator" content="Microsoft Word 15">
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Normal</w:View></w:WordDocument></xml><![endif]-->
<style>
<!--
p.MsoNormal, li.MsoNormal {margin:0cm; font-size:12.0pt; font-family:"Aptos",sans-serif;}
-->
</style>
</head>
<body lang="EN-US" style="tab-interval:36.0pt">
<!--StartFragment-->
<p class="MsoNormal"><b>US foreign health assistance is subject to expanded restrictions.</b> In January 2026, the State Department introduced the <a href="https://example.org/phifa"><i>PHIFA</i></a> policy.<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<h2>A new model</h2>
<ul><li>bilateral compacts</li><li>MOUs</li></ul>
<!--EndFragment-->
</body>
</html>`;

describe('clipboardHtmlToMarkdown', () => {
  it('returns an empty string for empty or blank HTML', async () => {
    expect(await clipboardHtmlToMarkdown('')).toBe('');
    expect(await clipboardHtmlToMarkdown('   ')).toBe('');
  });

  it('converts Word HTML to Markdown without leaking styles or Office markup', async () => {
    const md = await clipboardHtmlToMarkdown(WORD_HTML);

    expect(md).toContain(
      '**US foreign health assistance is subject to expanded restrictions.**',
    );
    expect(md).toContain('[_PHIFA_](https://example.org/phifa)');
    expect(md).toContain('## A new model');
    expect(md).toMatch(/[-*]\s+bilateral compacts/);

    expect(md).not.toContain('MsoNormal');
    expect(md).not.toContain('font-family');
    expect(md).not.toContain('WordDocument');
    expect(md).not.toContain('o:p');
    expect(md).not.toContain('StartFragment');
  });

  it('returns an empty string when only non-content elements remain', async () => {
    expect(
      await clipboardHtmlToMarkdown(
        '<html><head><style>p{}</style></head><body></body></html>',
      ),
    ).toBe('');
  });

  it('strips active content from a hostile clipboard before converting', async () => {
    const md = await clipboardHtmlToMarkdown(
      '<p>safe <b>text</b></p><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">link</a><iframe src="https://evil.example"></iframe>',
    );
    expect(md).toContain('safe **text**');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('javascript:');
    expect(md).not.toContain('evil.example');
  });
});
