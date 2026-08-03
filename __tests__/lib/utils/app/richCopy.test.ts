// @vitest-environment jsdom
import {
  selectionClipboardPayload,
  toPlainText,
} from '@/lib/utils/app/richCopy';

import { describe, expect, it } from 'vitest';

function containerOf(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

function selectAll(html: string): Selection {
  document.body.innerHTML = html;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(document.body);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe('toPlainText', () => {
  it('renders unordered lists with dash markers', () => {
    const root = containerOf(
      '<p>Réductions :</p><ul><li>la condensation de l’introduction ;</li><li>la synthèse des discussions ;</li></ul>',
    );
    expect(toPlainText(root)).toBe(
      'Réductions :\n\n- la condensation de l’introduction ;\n- la synthèse des discussions ;',
    );
  });

  it('renders ordered lists with numbering and nested lists indented', () => {
    const root = containerOf(
      '<ol><li>first<ul><li>sub a</li><li>sub b</li></ul></li><li>second</li></ol>',
    );
    expect(toPlainText(root)).toBe('1. first\n  - sub a\n  - sub b\n2. second');
  });

  it('keeps code block line breaks and separates paragraphs', () => {
    const root = containerOf(
      '<p>before</p><pre><code>line1\nline2</code></pre><p>after</p>',
    );
    expect(toPlainText(root)).toBe('before\n\nline1\nline2\n\nafter');
  });

  it('renders table cells tab-separated', () => {
    const root = containerOf(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(toPlainText(root)).toBe('a\tb\n1\t2');
  });
});

describe('selectionClipboardPayload', () => {
  it('returns null for a collapsed selection', () => {
    document.body.innerHTML = '<p>text</p>';
    window.getSelection()!.removeAllRanges();
    expect(selectionClipboardPayload(window.getSelection())).toBeNull();
  });

  it('keeps semantic formatting in the html flavor', () => {
    const payload = selectionClipboardPayload(
      selectAll('<p>file: <strong>geo.pptx</strong></p><ul><li>item</li></ul>'),
    );
    expect(payload?.html).toContain('<strong>geo.pptx</strong>');
    expect(payload?.html).toContain('<li>item</li>');
    expect(payload?.text).toBe('file: geo.pptx\n\n- item');
  });

  it('strips UI chrome buttons and tooltips from both flavors', () => {
    const payload = selectionClipboardPayload(
      selectAll(
        '<div><button>Copy</button><span class="citation-tooltip">tip</span><p>content</p></div>',
      ),
    );
    expect(payload?.html).not.toContain('Copy');
    expect(payload?.html).not.toContain('tip');
    expect(payload?.text).toBe('content');
  });

  it('restores newlines in span-per-line code blocks', () => {
    const payload = selectionClipboardPayload(
      selectAll(
        '<pre><code><span>const a = 1;</span><span>const b = 2;</span></code></pre>',
      ),
    );
    expect(payload?.html).toContain('const a = 1;\nconst b = 2;');
    expect(payload?.text).toBe('const a = 1;\nconst b = 2;');
  });

  it('scrubs leaked node attributes from the html flavor', () => {
    const payload = selectionClipboardPayload(
      selectAll('<p node="[object Object]">hello</p>'),
    );
    expect(payload?.html).not.toContain('node=');
  });
});
