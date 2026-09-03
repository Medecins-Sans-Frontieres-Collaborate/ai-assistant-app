import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import { parseMarkdownIntoBlocks } from 'streamdown';
import { describe, expect, it } from 'vitest';

/**
 * Conformance suite for issue #121. Every expectation below was measured
 * against the real render pipeline (Streamdown's block splitter + remark-math
 * + rehype-katex); the table is the executable half of DESIGN A's spec.
 *
 * `expected: undefined` means "must come through completely unchanged", which
 * is the assertion that matters most: this function runs on every render, so
 * touching text it should not touch is a worse defect than the bug it fixes.
 */
interface Case {
  name: string;
  input: string;
  /** Omit when the input must be returned verbatim. */
  expected?: string;
}

const DELIMITER_CONVERSION: Case[] = [
  {
    name: 'display \\[ … \\] on its own lines',
    input: 'Intro\n\n\\[\n\\frac{a}{b}\n\\]\n\nEnd',
    expected: 'Intro\n\n$$\n\\frac{a}{b}\n$$\n\nEnd',
  },
  {
    // `$$` for inline too: Streamdown pins remark-math with
    // `singleDollarTextMath: false`, so `$x^2$` would be literal text on
    // screen — a different piece of visible source, not a fix.
    name: 'inline \\( … \\) mid-sentence',
    input: 'Value \\( x^2 \\) here',
    expected: 'Value $$x^2$$ here',
  },
  {
    name: 'two inline regions in one sentence',
    input: '\\(\\alpha\\) and \\(\\beta\\)',
    expected: '$$\\alpha$$ and $$\\beta$$',
  },
  {
    // `\[` MEANS display. A one-line `$$…$$` is remark-math's INLINE construct
    // (measured: no `.katex-display`, no `display="block"`, `\sum` limits
    // beside the sigma) and, because `.katex .base` is `white-space: nowrap`,
    // the `.katex-display{overflow-x:auto}` rule in globals.css never applies,
    // so a wide derivation spills out of the bubble with no scrollbar.
    name: 'a \\[ … \\] alone on its line becomes DISPLAY math, not inline',
    input: 'MMR:\n\n\\[ \\sum_{i=1}^{n} \\frac{x_i}{n} \\]\n\nDone.',
    expected: 'MMR:\n\n$$\n\\sum_{i=1}^{n} \\frac{x_i}{n}\n$$\n\nDone.',
  },
  {
    // The other half of the same rule. Promoting a mid-sentence region is
    // destructive: measured, `The value $$\n…\n$$ is here.` swallows
    // " is here." entirely.
    name: 'display region mid-sentence stays on one line, padding intact',
    input: 'Answer \\[ x = 1 \\] done',
    expected: 'Answer $$ x = 1 $$ done',
  },
  {
    // A bullet whose text IS the equation. Lifting it onto its own lines would
    // pull it out of the list item, so OWN_LINE_PREFIX excludes list markers.
    name: 'a \\[ … \\] that is a list item stays inline',
    input: '- step\n- \\[ x^2 = 1 \\]\n- three',
    expected: '- step\n- $$ x^2 = 1 $$\n- three',
  },
  {
    name: 'a promoted region inside a blockquote keeps its markers',
    input: '> \\[ x^2 = 1 \\]',
    expected: '> $$\n> x^2 = 1\n> $$',
  },
  {
    name: 'adjacent display regions get a separator (else NEITHER renders)',
    input: '\\[a^2\\]\\[b^2\\]',
    expected: '$$a^2$$ $$b^2$$',
  },
  {
    name: 'inline region inside a table cell',
    input: 'table | $x$ | \\(y^2\\) |',
    expected: 'table | $x$ | $$y^2$$ |',
  },
  {
    // Single-dollar output would be INERT: Streamdown pins remark-math with
    // `singleDollarTextMath: false`, so `$x$` reaches the reader as literal
    // text. `$$` on one line is inline math to remark-math, which is what
    // `\( … \)` meant in the first place.
    name: 'inline conversion never emits a single-dollar delimiter',
    input: 'Then \\(\\alpha\\) and \\( x^2 \\) and \\(y_1\\).',
    expected: 'Then $$\\alpha$$ and $$x^2$$ and $$y_1$$.',
  },
];

const CONVERSION_GUARDS: Case[] = [
  {
    name: 'prose between \\[ and \\] is not an equation',
    input: 'Escaped bracket prose: use \\[ and \\] to escape',
  },
  {
    name: 'a bracketed aside is not an equation',
    input: 'matrices \\[i.e. arrays\\] are common',
  },
  {
    name: 'accepted false negative: bare letters have no math signal',
    input: '\\(ABC\\) triangle',
  },
  { name: 'empty region', input: '\\[\\]' },
  {
    name: 'nested opener means the closer is ambiguous; copy verbatim',
    input: 'nested \\( \\frac{\\(x\\)}{2} \\)',
  },
  {
    name: 'a LaTeX \\\\[2pt] line break is not a display opener',
    input: '$$\\begin{aligned} a \\\\[2pt] b \\end{aligned}$$',
  },

  // `\[` / `\]` is ALSO how markdown escapes a literal bracket, so every case
  // below is prose whose brackets the author deliberately kept. Converting one
  // does not merely restyle it — it DELETES the brackets: measured, `\[a-z\]`
  // rendered as `a−z` and `\[2\]` as `2`, on screen and in the .docx alike.
  {
    name: 'a character class is not an equation',
    input: 'The character class \\[a-z\\] matches lowercase letters.',
  },
  {
    name: 'a section number is not an equation',
    input: 'See section \\[3.2\\] of the protocol for details.',
  },
  {
    name: 'a form placeholder is not an equation',
    input: 'Replace \\[site 1\\] and \\[site 2\\] in the form.',
  },
  {
    name: 'a citation marker is not an equation',
    input: 'See the report \\[1\\] and the annex \\[2\\].',
  },
  {
    name: 'a two-character body is not an equation',
    input: 'Mark it \\[ok\\] when the task \\[x\\] is done.',
  },
  {
    name: 'a numeric range is not an equation',
    input: 'The acceptable range \\(0-10\\) is documented.',
  },

  // An unpaired opener must never reach forward across a paragraph break to
  // pair with an unrelated closer. Measured before the bound: the two
  // paragraphs fused, a literal `$$` appeared on screen, and everything after
  // the false closer was DELETED from the render.
  {
    // Both of these carry a math signal (`=`) inside the would-be region, so
    // mathPlausible cannot be what saves them — only the paragraph bound can.
    name: 'an unpaired \\[ does not pair with a \\] two paragraphs later',
    input:
      'To show a literal bracket, type \\[ in your document.\n\nIn section 2, where x = 1, we explain how \\] behaves.',
  },
  {
    name: 'a dropped closer does not swallow the paragraphs after it',
    input:
      'The area is \\[ A = \\pi r^2 and that is all.\n\nNext paragraph has a - dash in it.\n\nLater we write \\] by mistake.',
  },
  {
    name: 'an unpaired \\( behaves the same way',
    input:
      'Type \\( to open a span.\n\nLater, with n = 2, a stray \\) appears in the text.',
  },
];

const DISPLAY_REGIONS: Case[] = [
  {
    name: 'blank line inside $$ is what splits the equation across blocks',
    input:
      'Result:\n\n$$\n\\begin{aligned}\na &= b \\\\\n\nc &= d\n\\end{aligned}\n$$\n\nDone',
    expected:
      'Result:\n\n$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\nDone',
  },
  {
    name: '$$\\begin{aligned} on the opening line (content is silently eaten today)',
    input: '$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$',
    expected: '$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$',
  },
  {
    name: 'rules 2 and 3 compose',
    input: '\\[\n\\begin{aligned}\na &= b \\\\\n\nc &= d\n\\end{aligned}\n\\]',
    expected: '$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$',
  },
  {
    name: 'single-line $$ stays inline (promoting it would reflow the sentence)',
    input: 'Value $$x^2$$ inline',
  },
  {
    name: 'trailing $$ on its own line (renders a silent empty box today)',
    input: '$$x = 1\n$$',
    expected: '$$\nx = 1\n$$',
  },
  {
    name: 'leading newline but trailing $$ glued to the body',
    input: '$$\nx = 1$$',
    expected: '$$\nx = 1\n$$',
  },
  {
    name: 'list-item indentation is preserved on every emitted line',
    input:
      '- Step:\n\n  $$\\begin{aligned}\n  a &= b\n  \\end{aligned}$$\n\n- Next',
    expected:
      '- Step:\n\n  $$\n  \\begin{aligned}\n  a &= b\n  \\end{aligned}\n  $$\n\n- Next',
  },
  {
    // The closing `$$` used to lose its `> ` prefix, which ended the quote
    // early and left a second, EMPTY display box sitting outside it.
    name: 'blockquote markers are carried onto every emitted line',
    input: '> The ratio:\n>\n> $$\n> \\frac{a}{b}\n> $$',
    expected: '> The ratio:\n>\n> $$\n> \\frac{a}{b}\n> $$',
  },
  {
    name: 'a `>`-only line inside a quoted equation counts as blank',
    input:
      '> $$\n> \\begin{aligned}\n> a &= b \\\\\n>\n> c &= d\n> \\end{aligned}\n> $$',
    expected:
      '> $$\n> \\begin{aligned}\n> a &= b \\\\\n> c &= d\n> \\end{aligned}\n> $$',
  },
  {
    // `>` is a relation in math mode. Only an opener that actually carried a
    // quote marker may have quote markers stripped off its body.
    name: 'a leading `>` in UNQUOTED display math is content, not a marker',
    input: '$$\na\n> b\n$$',
  },
  { name: 'empty display region', input: '$$ $$' },
  { name: 'already-canonical inline display region', input: '$$E=mc^2$$' },
];

const PROTECTED_REGIONS: Case[] = [
  {
    name: 'shell fence: $HOME and a stray \\[ survive verbatim',
    input: '```sh\necho $HOME and $PATH\n\\[ x \\]\n```',
  },
  {
    name: 'mermaid fence with dollars in a node label',
    input: '```mermaid\nflowchart TD\n  A["$5 and $6"] --> B\n```',
  },
  {
    name: 'latex fence is left as source, not promoted to math',
    input: '```latex\n\\[ \\frac{a}{b} \\]\n```',
  },
  {
    name: 'tilde fence',
    input: '~~~\ncost $5 and $6\n~~~',
  },
  {
    name: 'fence nested in a list item (indented past CommonMark 3 spaces)',
    input: '- item\n\n    ```sh\n    echo $HOME and $PATH\n    ```\n',
  },
  {
    name: 'unterminated fence is protected to end of input (streaming)',
    input: '```sh\necho $HOME and $PATH\n',
  },

  // A fence legally opens inside a container. Requiring pure whitespace before
  // the marker left these unprotected, and the accidental save (matchInlineCode
  // finding a later matching backtick run) does not exist for a `~~~` fence or
  // for a fence still streaming — so the `\$` was permanent, not a flicker.
  {
    name: 'tilde fence inside a blockquote',
    input: '> ~~~sh\n> echo $5,000 and $3,000\n> ~~~',
  },
  {
    name: 'backtick fence inside a blockquote',
    input: '> ```sh\n> echo $5,000 and $3,000\n> ```',
  },
  {
    name: 'fence on a list-marker line, still streaming',
    input: '- ```bash\n  echo $HOME and $PATH',
  },
  {
    name: 'quoted fence, streaming prefix',
    input: '> ```sh\n> echo $5,000 and $3,',
  },
  {
    name: 'fence on an ordered-list marker line',
    input: '1. ```sh\n   echo $5,000 and $3,000\n   ```',
  },
  {
    name: 'inline code span is protected, prose around it is not',
    input: 'Use `echo $HOME and $PATH` plus \\( y^2 \\)',
    expected: 'Use `echo $HOME and $PATH` plus $$y^2$$',
  },
  {
    name: 'double-backtick span containing a backtick',
    input: 'Run ``echo `$HOME` and $PATH`` now',
  },
  {
    name: 'stream sentinel block',
    input: 'text <<<METADATA_START>>>{"a":"$5 and $6"}<<<METADATA_END>>>',
  },
  {
    name: 'citation-quotes sentinel block',
    input: 'a <<<CITATION_QUOTES>>>$5 and $6<<<END_CITATION_QUOTES>>> b',
  },
  {
    name: 'raw <pre> block',
    input: 'before <pre>echo $HOME and $PATH</pre> after',
  },
  {
    name: '4-space indented code block',
    input: '4-space indented code:\n\n    echo $HOME and $PATH\n',
  },
];

const CURRENCY_POSITIVES: Case[] = [
  {
    name: 'grouped thousands (the reported MSF case)',
    input: 'Budget is $5,000 for supplies and $12,000 for staff',
    expected: 'Budget is \\$5,000 for supplies and $12,000 for staff',
  },
  {
    name: 'sigil separated from the amount',
    input: 'US$ 40 per kit and US$ 60 per crate',
    expected: 'US\\$ 40 per kit and US$ 60 per crate',
  },
  {
    name: 'bare small amounts',
    input: 'It costs $5 and $6',
    expected: 'It costs \\$5 and $6',
  },
  {
    name: 'price range (trailing dash, no whitespace)',
    input: 'Prices range $10-$20 per unit',
    expected: 'Prices range \\$10-$20 per unit',
  },
  {
    name: 'grouped thousands beat the math-signal veto',
    input: 'We spent $5,000 + $3,000 on kits',
    expected: 'We spent \\$5,000 + $3,000 on kits',
  },
  {
    name: 'space-grouped amounts',
    input: 'Costs $5 000 and $6 000',
    expected: 'Costs \\$5 000 and $6 000',
  },
  {
    name: 'decimals',
    input: 'Total: $1,234.56 and $2,000.00 respectively',
    expected: 'Total: \\$1,234.56 and $2,000.00 respectively',
  },
  {
    name: 'magnitudes',
    input: '$100 million versus $250 million',
    expected: '\\$100 million versus $250 million',
  },
  {
    name: 'span crossing a line break but not a blank line',
    input: 'Pay $5\nor $6',
    expected: 'Pay \\$5\nor $6',
  },
  {
    name: 'shell variables outside a fence',
    input: 'echo $HOME and $PATH',
    expected: 'echo \\$HOME and $PATH',
  },
  {
    name: 'only the OPENER is escaped, so the real equation after it survives',
    input: 'We spent $5,000 on $\\alpha$ testing',
    expected: 'We spent \\$5,000 on $\\alpha$ testing',
  },
  {
    name: 'currency followed by inline math',
    input: 'Cost $12,000 for the $n$-th cohort',
    expected: 'Cost \\$12,000 for the $n$-th cohort',
  },
  {
    name: 'currency then an equation with an operator',
    input: 'A price of $5 and math $y=2$ together',
    expected: 'A price of \\$5 and math $y=2$ together',
  },
];

const CURRENCY_NEGATIVES: Case[] = [
  { name: 'unpaired sigil is already literal', input: 'It costs $5' },
  { name: 'lone sigil in prose', input: '50% of $ signs are fine' },
  { name: 'numeric math with no prose whitespace', input: '$100$ people' },
  { name: 'single-letter variable', input: 'Let $x$ be a variable' },
  {
    name: 'padded inline math with operators',
    input: 'If $ 2x + 3 = 7 $ then $x = 2$',
  },
  {
    name: 'geometry labels stay math',
    input: 'Angles $ABC$ and $DEF$ are equal',
  },
  {
    name: 'TeX command vetoes the amount tier',
    input: 'The value $2\\pi r$ is the circumference',
  },
  {
    name: 'several short inline variables',
    input: 'Rate $r$, count $n$, total $rn$',
  },
  {
    name: 'blank line breaks the inline span, so nothing pairs',
    input: 'Pay $5\n\nor $6',
  },
  {
    name: 'already escaped (idempotency guard)',
    input: 'Budget is \\$5,000 for supplies',
  },

  // GFM's literal-autolink extension does not process backslash escapes, so a
  // `\` added inside a bare URL survives into the href as `%5C` — a 404 — and
  // shows as a stray backslash in the link text. Measured on both renderers.
  {
    name: 'a $ inside a bare URL is part of the link, not currency',
    input: 'Try https://ex.com/a$1,000/b and https://ex.com/$2,000 now.',
  },
  {
    name: 'a bare URL is left alone even when prose currency follows',
    input:
      'See https://ex.com/report?amt=$1,000 and the budget is \\$5,000 total.',
  },
  {
    name: 'www.-style autolink',
    input: 'Visit www.ex.com/a$1,000/b and www.ex.com/$2,000 today.',
  },
];

const STREAMING_PARTIALS: Case[] = [
  { name: 'unterminated \\[', input: 'a \\[ \\frac{a' },
  { name: 'unterminated \\(', input: 'a \\( x^2' },
  { name: 'unterminated $$', input: 'a $$\\frac{a}{b' },
  { name: 'unterminated currency span', input: 'Budget is $5,0' },
  {
    name: 'half-arrived sentinel marker',
    input: 'text <<<METADATA_START>>>{"a":"$5',
  },
  { name: 'lone opening backslash', input: 'a \\' },
];

const ALL_CASES: Case[] = [
  ...DELIMITER_CONVERSION,
  ...CONVERSION_GUARDS,
  ...DISPLAY_REGIONS,
  ...PROTECTED_REGIONS,
  ...CURRENCY_POSITIVES,
  ...CURRENCY_NEGATIVES,
  ...STREAMING_PARTIALS,
];

const GROUPS: Array<[string, Case[]]> = [
  ['\\[ \\] and \\( \\) conversion', DELIMITER_CONVERSION],
  ['conversion guards', CONVERSION_GUARDS],
  ['display-region normalization', DISPLAY_REGIONS],
  ['protected regions', PROTECTED_REGIONS],
  ['currency escaping', CURRENCY_POSITIVES],
  ['currency false-positive battery', CURRENCY_NEGATIVES],
  ['streaming partials', STREAMING_PARTIALS],
];

describe('normalizeMathDelimiters', () => {
  for (const [group, cases] of GROUPS) {
    describe(group, () => {
      for (const testCase of cases) {
        it(testCase.name, () => {
          expect(normalizeMathDelimiters(testCase.input)).toBe(
            testCase.expected ?? testCase.input,
          );
        });
      }
    });
  }

  describe('fast path', () => {
    it('returns the input reference when there is no math-ish character', () => {
      const input = 'Plain prose with no dollars, brackets or parens.';
      expect(normalizeMathDelimiters(input)).toBe(input);
    });

    it('handles the empty string', () => {
      expect(normalizeMathDelimiters('')).toBe('');
    });
  });

  describe('idempotency', () => {
    // The function runs on both the render and the export path, so it can and
    // will see its own output. A second pass must be a no-op.
    for (const testCase of ALL_CASES) {
      it(`is idempotent: ${testCase.name}`, () => {
        const once = normalizeMathDelimiters(testCase.input);
        expect(normalizeMathDelimiters(once)).toBe(once);
      });
    }
  });

  describe('streaming monotonicity', () => {
    // Replaying a message one character at a time, the output should only ever
    // GROW. A transition where the new output is not a prefix-extension of the
    // previous one is a visible flicker; the one permitted here is the instant
    // the closing `\]` arrives and the region converts.
    const message = 'Area is \\[ \\frac{a}{b} \\] done.';

    it('produces at most one visible transition per math region', () => {
      let previous = '';
      let transitions = 0;
      for (let end = 1; end <= message.length; end++) {
        const output = normalizeMathDelimiters(message.slice(0, end));
        if (previous && !output.startsWith(previous)) transitions++;
        previous = output;
      }
      expect(transitions).toBe(1);
    });

    it('never emits a partial dollar delimiter before the region closes', () => {
      // Everything up to the closing `\]` must still be literal text: an early
      // `$$` would let remend auto-close it into a churning KaTeX error span.
      const closerIndex = message.indexOf('\\]');
      for (let end = 1; end <= closerIndex + 1; end++) {
        const prefix = message.slice(0, end);
        expect(normalizeMathDelimiters(prefix)).toBe(prefix);
      }
    });
  });

  describe('block-split invariant', () => {
    // Streamdown pre-splits content into independently-parsed blocks on blank
    // lines with no `$$` awareness. This is the assertion that the normalizer
    // actually fixes the reported rendering bug rather than merely tidying the
    // source text.
    const source =
      'Here:\n\n$$\n\\begin{aligned}\na &= b \\\\\n\nc &= d\n\\end{aligned}\n$$\n\nDone.';

    it('reproduces the split on raw content', () => {
      const mathBlocks = parseMarkdownIntoBlocks(source).filter((block) =>
        block.includes('$$'),
      );
      expect(mathBlocks.length).toBeGreaterThan(1);
    });

    it('keeps a multi-line \\begin{aligned} equation in exactly one block', () => {
      const normalized = normalizeMathDelimiters(source);
      const blocks = parseMarkdownIntoBlocks(normalized);
      const mathBlocks = blocks.filter((block) => block.includes('$$'));

      expect(mathBlocks).toHaveLength(1);
      expect(mathBlocks[0]).toContain('\\begin{aligned}');
      expect(mathBlocks[0]).toContain('\\end{aligned}');
    });

    it('leaves no blank line inside any display region', () => {
      // Renderer-independent statement of the same invariant, so this suite
      // still guards the behaviour if Streamdown's splitter is ever swapped.
      const normalized = normalizeMathDelimiters(source);
      for (const region of normalized
        .split('$$')
        .filter((_, i) => i % 2 === 1)) {
        expect(region).not.toMatch(/\n[ \t]*\n/);
      }
    });
  });

  describe('performance', () => {
    it('stays cheap enough to run on every render', () => {
      const document = 'Budget is $5,000 and \\( x^2 \\) plus text.\n\n'.repeat(
        1000,
      );
      const start = performance.now();
      normalizeMathDelimiters(document);
      expect(performance.now() - start).toBeLessThan(250);
    });
  });
});
