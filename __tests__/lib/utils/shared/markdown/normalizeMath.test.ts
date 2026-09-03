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
    name: 'display region mid-sentence keeps its inner padding',
    input: 'Answer \\[ x = 1 \\] done',
    expected: 'Answer $$ x = 1 $$ done',
  },
  {
    name: 'adjacent display regions get a separator (else NEITHER renders)',
    input: '\\[a\\]\\[b\\]',
    expected: '$$a$$ $$b$$',
  },
  {
    name: 'inline region inside a table cell',
    input: 'table | $x$ | \\(y\\) |',
    expected: 'table | $x$ | $$y$$ |',
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
  {
    name: 'inline code span is protected, prose around it is not',
    input: 'Use `echo $HOME and $PATH` plus \\( y \\)',
    expected: 'Use `echo $HOME and $PATH` plus $$y$$',
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
