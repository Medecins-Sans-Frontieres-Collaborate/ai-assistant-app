import { markdownToHtml } from '@/lib/utils/shared/document/formatConverter';
import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import { describe, expect, it, vi } from 'vitest';

// formatConverter pulls in DOMPurify for its sanitize paths; none of the math
// work touches them, and the real module spins up jsdom.
vi.mock('@/lib/utils/shared/document/domPurify', () => ({
  getDOMPurify: vi.fn().mockResolvedValue({ sanitize: (html: string) => html }),
}));

const raw = String.raw;
const lines = (...parts: string[]) => parts.join('\n');

/**
 * The text a reader ends up with. Every export format reduces this HTML to its
 * text: `.txt` via DOMPurify's tag strip, `.docx` via html-to-docx's text
 * runs, `.md` via the markdown source, `.html`/`.pdf` by being read. So the
 * contract is stated in terms of text, and only the three characters the math
 * renderer escapes need decoding.
 */
function mathText(html: string): string[] {
  return [
    ...html.matchAll(
      /<(?:div|span) class="math [^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/g,
    ),
  ].map((match) =>
    match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  );
}

describe('markdownToHtml — the export math contract (issue #121, C6)', () => {
  describe('math survives as its exact TeX source', () => {
    it('emits a display block whose text is the normalized markdown verbatim', () => {
      const markdown = lines(
        'Result:',
        '',
        '$$',
        raw`\frac{a}{b}`,
        '$$',
        '',
        'Done.',
      );
      const html = markdownToHtml(markdown);

      expect(html).toContain('class="math math-display"');
      expect(mathText(html)).toEqual([lines('$$', raw`\frac{a}{b}`, '$$')]);
      // The prose around it is still prose.
      expect(html).toContain('Result:');
      expect(html).toContain('Done.');
    });

    it('keeps a multi-line aligned block in ONE element, with no <br> in it', () => {
      const markdown = lines(
        '$$',
        raw`\begin{aligned}`,
        raw`a &= b \\`,
        'c &= d',
        raw`\end{aligned}`,
        '$$',
      );
      const html = markdownToHtml(markdown);

      // `breaks: true` is what used to shred this into `$$<br>\frac…<br>$$`.
      expect(html).not.toContain('<br>');
      expect(mathText(html)).toEqual([
        lines(
          '$$',
          raw`\begin{aligned}`,
          raw`a &= b \\`,
          'c &= d',
          raw`\end{aligned}`,
          '$$',
        ),
      ]);
    });

    it('round-trips TeX containing <, > and & through HTML escaping', () => {
      const html = markdownToHtml(raw`Given $$a < b > c \& d$$ we proceed.`);
      // Escaped in the markup...
      expect(html).toContain('&lt;');
      expect(html).toContain('&amp;');
      // ...and identical to the source once decoded.
      expect(mathText(html)).toEqual([raw`$$a < b > c \& d$$`]);
    });

    it('renders single-line $$…$$ inline, matching the screen renderer', () => {
      const html = markdownToHtml('The area $$A = \\pi r^2$$ grows.');
      expect(html).toContain('class="math math-inline"');
      expect(html).not.toContain('math-display');
      // One paragraph — the equation must not split the sentence in two.
      expect(html.match(/<p>/g)).toHaveLength(1);
    });
  });

  describe('delimiters the model actually emits', () => {
    it('keeps \\[ … \\] instead of letting marked eat the backslashes', () => {
      const html = markdownToHtml(
        lines('Answer:', '', raw`\[`, raw`\frac{a}{b}`, raw`\]`),
      );

      // The pre-fix output was `<p>[ \frac{a}{b} ]</p>` — delimiters gone.
      expect(html).not.toContain('<p>[');
      expect(mathText(html)).toEqual([lines('$$', raw`\frac{a}{b}`, '$$')]);
    });

    it('keeps \\( … \\) TeX intact instead of eating its backslashes', () => {
      const html = markdownToHtml(raw`The area \( A = \pi r^2 \) grows.`);

      // Bare marked read `\(` and `\)` as markdown escapes and produced
      // `<p>The area ( A = \pi r^2 ) grows.</p>` — the delimiters were gone for
      // good and no downstream tool could recover the equation. Asserted on the
      // TeX rather than on a math element because WHICH delimiter this becomes
      // is `normalizeMathDelimiters`' decision, not this module's; whatever it
      // emits, the export recognises exactly what the screen recognises
      // (`$$` yes, `$` no) — see the negative cases below.
      expect(html).not.toContain('<p>The area ( A');
      expect(html).toContain(raw`A = \pi r^2`);
    });

    it('treats a ```math fence as display math, as the screen renderer does', () => {
      const html = markdownToHtml('```math\nE = mc^2\n```');
      expect(html).toContain('class="math math-display"');
      expect(mathText(html)).toEqual([lines('$$', 'E = mc^2', '$$')]);
    });

    it('leaves a ```latex fence as a code block — the author asked to SEE the TeX', () => {
      const html = markdownToHtml('```latex\n\\frac{a}{b}\n```');
      expect(html).toContain('<pre>');
      expect(html).not.toContain('class="math');
    });
  });

  describe('what must NOT become math', () => {
    it('leaves currency alone, exactly as the screen renderer does', () => {
      const html = markdownToHtml(
        'Budget is $5,000 for supplies and $12,000 for staff.',
      );
      expect(html).not.toContain('class="math');
      // The escaping the normalizer adds is a markdown escape; marked unescapes
      // it, so the reader still sees the amounts.
      expect(html).toContain('$5,000');
      expect(html).toContain('$12,000');
    });

    it('leaves single-dollar spans literal, because the screen does too', () => {
      const html = markdownToHtml('Let $x$ be the number of kits.');
      expect(html).not.toContain('class="math');
      expect(html).toContain('$x$');
    });

    it('does not reach inside a fenced code block', () => {
      const html = markdownToHtml('```sh\necho $$HOME$$\n```');
      expect(html).not.toContain('class="math');
      expect(html).toContain('$$HOME$$');
    });

    it('does not reach inside an inline code span', () => {
      const html = markdownToHtml('Type `$$x$$` to write inline math.');
      expect(html).not.toContain('class="math');
      expect(html).toContain('<code>$$x$$</code>');
    });
  });

  describe('stability', () => {
    it('is unaffected by a caller having already normalized (idempotent input)', () => {
      const markdown = lines(
        'Answer:',
        '',
        raw`\[ \frac{a}{b} \]`,
        '',
        'Done.',
      );
      expect(markdownToHtml(normalizeMathDelimiters(markdown))).toBe(
        markdownToHtml(markdown),
      );
    });

    it('leaves markdown with no math byte-identical to the old behaviour', () => {
      const html = markdownToHtml(
        '# Title\n\nSome **bold** text and a [link](https://x).',
      );
      expect(html).toContain('<h1');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('href="https://x"');
      expect(html).not.toContain('class="math');
    });
  });
});
