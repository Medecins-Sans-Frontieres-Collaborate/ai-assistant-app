import { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CitationStreamdown } from '@/components/Markdown/CitationStreamdown';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

/**
 * Exercises the REAL streamdown + remark-math + rehype-katex + rehype-sanitize
 * chain. These are the regression tests for issue #121: two things have to be
 * simultaneously true, and either one alone still shows the user raw TeX —
 * (1) the delimiters a model actually emits must reach remark-math in a shape
 * it understands, and (2) what KaTeX produces must survive Streamdown's
 * sanitize step, which runs AFTER rehype-katex.
 *
 * Rendered to static markup rather than mounted: Streamdown's effects
 * `import('katex/dist/katex.min.css')` when it sees `$$`, and a raw CSS import
 * is unloadable under the node ESM loader that serves externalized deps. The
 * markup is what these assertions are about anyway.
 */
function renderHtml(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

describe('CitationStreamdown — math rendering', () => {
  it('renders a KaTeX equation with its classes and MathML intact', () => {
    const host = renderHtml(
      <CitationStreamdown mode="static">
        {'$$\\frac{a}{b}$$'}
      </CitationStreamdown>,
    );

    // Streamdown sanitizes after rehype-katex with an HTML-only schema, which
    // strips every katex class and unwraps the MathML to bare text — the
    // "denominator, numerator, then raw TeX" soup users reported seeing.
    expect(host.querySelector('.katex')).not.toBeNull();
    expect(host.querySelector('.katex-mathml math')).not.toBeNull();
    expect(host.querySelector('.katex-error')).toBeNull();
    expect(
      host.querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent,
    ).toBe('\\frac{a}{b}');
  });

  it('renders \\[ ... \\] as an equation rather than literal brackets', () => {
    const host = renderHtml(
      <CitationStreamdown mode="static">
        {'The area \\[ \\pi r^2 \\] grows.'}
      </CitationStreamdown>,
    );

    expect(host.querySelector('.katex')).not.toBeNull();
    expect(host.querySelector('.katex-error')).toBeNull();

    // Untouched, remark-math never sees math here and markdown escaping eats
    // the backslashes, leaving "[ \pi r^2 ]" on screen.
    expect(host.textContent ?? '').not.toContain('\\[');
    expect(host.textContent ?? '').not.toContain('[ \\pi r^2 ]');
  });

  it('strips the \\( ... \\) delimiters models emit for inline math', () => {
    const host = renderHtml(
      <CitationStreamdown mode="static">
        {'Value \\( x^2 \\) here'}
      </CitationStreamdown>,
    );

    // Untouched, markdown escaping eats the backslashes and the reader sees
    // "( x^2 )". NOTE: Streamdown pins remark-math with
    // `singleDollarTextMath: false`, so the `$ … $` the normalizer currently
    // emits for this case is inert here and shows literal dollar signs —
    // inline math has to reach this renderer as `$$ … $$`. Tracked separately;
    // the invariant asserted here is only that no raw `\(` survives.
    expect(host.textContent ?? '').not.toContain('\\(');
    expect(host.querySelector('.katex-error')).toBeNull();
  });

  it('keeps a multi-line \\begin{aligned} block as ONE equation with no error', () => {
    // The blank line inside the block is what Streamdown's block splitter cuts
    // on, producing a red ParseError span plus a literal "\end{aligned}".
    const markdown =
      'Result:\n\n$$\n\\begin{aligned}\na &= b \\\\\n\nc &= d\n\\end{aligned}\n$$\n\nDone.';

    const host = renderHtml(
      <CitationStreamdown mode="static">{markdown}</CitationStreamdown>,
    );

    expect(host.querySelectorAll('.katex-error')).toHaveLength(0);
    expect(host.querySelectorAll('.katex-display')).toHaveLength(1);
    // The TeX source legitimately survives inside the hidden MathML
    // `<annotation>`; what must NOT contain it is the visible layer.
    expect(host.querySelector('.katex-html')?.textContent ?? '').not.toContain(
      '\\end{aligned}',
    );

    const tex = host.querySelector(
      'annotation[encoding="application/x-tex"]',
    )?.textContent;
    expect(tex).toContain('\\begin{aligned}');
    expect(tex).toContain('\\end{aligned}');
  });

  it('handles the same \\begin{aligned} block written with \\[ ... \\]', () => {
    const markdown =
      '\\[\n\\begin{aligned}\na &= b \\\\\n\nc &= d\n\\end{aligned}\n\\]';

    const host = renderHtml(
      <CitationStreamdown mode="static">{markdown}</CitationStreamdown>,
    );

    expect(host.querySelectorAll('.katex-error')).toHaveLength(0);
    expect(host.querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('leaves the markdown alone when normalizeMath is off (user-authored text)', () => {
    // Someone who typed \[ may have meant to SHOW LaTeX source. Unlike model
    // output there is no upstream prompt to correct, so we render as written.
    const host = renderHtml(
      <CitationStreamdown mode="static" normalizeMath={false}>
        {'Use \\[ and \\] to escape'}
      </CitationStreamdown>,
    );

    expect(host.querySelector('.katex')).toBeNull();
  });

  it('does not touch math-looking text inside code', () => {
    // Shiki renders fenced blocks asynchronously, so the fence contributes no
    // text to static markup — the assertion that carries weight is that
    // neither form produced an equation.
    const host = renderHtml(
      <CitationStreamdown mode="static">
        {'Run `\\[ x \\]` first.\n\n```text\necho $HOME\n\\[ y \\]\n```'}
      </CitationStreamdown>,
    );

    expect(host.querySelector('.katex')).toBeNull();
    expect(host.querySelector('code')?.textContent).toBe('\\[ x \\]');
  });
});
