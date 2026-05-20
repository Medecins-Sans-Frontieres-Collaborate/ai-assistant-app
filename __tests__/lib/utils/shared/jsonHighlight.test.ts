import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { highlightJsonTokens } from '@/lib/utils/shared/jsonHighlight';

import { describe, expect, it } from 'vitest';

function render(json: string): string {
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, ...highlightJsonTokens(json)),
  );
}

describe('highlightJsonTokens', () => {
  it('returns plain spans for content without recognized tokens', () => {
    const html = render('{}');
    expect(html).toContain('{');
    expect(html).toContain('}');
  });

  it('colors a string key', () => {
    const html = render('{"query": "x"}');
    // renderToStaticMarkup HTML-escapes quotes to &quot;
    expect(html).toMatch(/text-sky-700[^>]*>&quot;query&quot;:/);
  });

  it('colors a string value', () => {
    const html = render('{"q": "microsoft"}');
    expect(html).toMatch(/text-orange-700[^>]*>&quot;microsoft&quot;</);
  });

  it('colors numbers', () => {
    const html = render('{"n": 42}');
    expect(html).toMatch(/text-purple-700[^>]*>42</);
  });

  it('colors floating-point numbers and negatives', () => {
    const html = render('{"a": -3.14}');
    expect(html).toMatch(/text-purple-700[^>]*>-3.14</);
  });

  it('colors keywords true/false/null', () => {
    expect(render('true')).toMatch(/text-emerald-700[^>]*>true</);
    expect(render('false')).toMatch(/text-emerald-700[^>]*>false</);
    expect(render('null')).toMatch(/text-emerald-700[^>]*>null</);
  });

  it('handles escaped quotes inside strings', () => {
    const html = render('{"msg":"he said \\"hi\\""}');
    expect(html).toContain('&quot;msg&quot;');
    // The inner-escaped quote stays in the source as a backslash-quote;
    // renderToStaticMarkup encodes the surrounding " as &quot; but keeps
    // the literal escaped sequence intact.
    expect(html).toContain('he said');
    expect(html).toContain('hi');
  });

  it('escapes any HTML in the input rather than injecting it', () => {
    const html = render('{"msg":"<script>alert(1)</script>"}');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('preserves whitespace and structure between tokens', () => {
    const json = '{\n  "a": 1\n}';
    const html = render(json);
    expect(html).toContain('  ');
    expect(html).toContain('\n');
  });
});
