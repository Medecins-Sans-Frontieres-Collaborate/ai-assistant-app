import { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MathStreamdown } from '@/components/Markdown/MathStreamdown';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

function renderHtml(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

/**
 * MathStreamdown is renderer CONFIG only — it repairs Streamdown's sanitize
 * step so KaTeX output survives, and deliberately does not rewrite delimiters.
 * That split is what lets user-authored surfaces (UserMessage, the terms
 * modal) render math correctly without having their literal text rewritten.
 */
describe('MathStreamdown', () => {
  it('renders KaTeX output with its classes and MathML intact', () => {
    const host = renderHtml(
      <MathStreamdown mode="static">{'$$E = mc^2$$'}</MathStreamdown>,
    );

    expect(host.querySelector('.katex')).not.toBeNull();
    expect(host.querySelector('.katex-mathml math')).not.toBeNull();
    expect(host.querySelector('.katex-error')).toBeNull();
  });

  it('does NOT rewrite \\[ ... \\] — delimiter normalization stays at the call site', () => {
    const host = renderHtml(
      <MathStreamdown mode="static">{'Use \\[ and \\] here'}</MathStreamdown>,
    );

    expect(host.querySelector('.katex')).toBeNull();
  });
});
