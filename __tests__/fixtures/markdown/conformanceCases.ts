/**
 * Shared corpus for the markdown/math rendering conformance harness.
 *
 * ONE corpus, four assertion families (each its own spec file under
 * `__tests__/lib/markdown/`):
 *
 *   1. renderConformance      leak detector — nothing a reader should never see
 *   2. blockSplitInvariant    Streamdown parses each block independently
 *   3. streamingMonotonicity  prefix replay through remend, as streaming does
 *   4. rendererParity         screen vs export vs TTS, downgrades declared
 *
 * Adding coverage is ONE object literal in `CONFORMANCE_CASES` — every family
 * picks it up automatically. That is the point: the next math bug should be
 * caught by a case, not by a new test file.
 *
 * WHY THE EXPECTATIONS LOOK THE WAY THEY DO (measured, not assumed — see
 * `renderPipelines.ts` for the pipeline these were measured through):
 *
 * - Streamdown pins remark-math with `singleDollarTextMath: false`, so `$x$`
 *   is INERT in this app and renders as literal text. That is deliberate: it
 *   is what stops "Budget is $5,000 for X and $12,000 for Y" typesetting the
 *   prose between the two sigils. Consequence: `$$…$$` is the ONLY delimiter
 *   that renders, for both inline and display, and it is what the normalizer
 *   must emit. Several cases below are negative anchors that fail loudly if
 *   anyone "fixes" currency by enabling `singleDollarTextMath`.
 * - `$$…$$` on ONE line renders INLINE; `$$` alone on its own lines renders
 *   as a display block. Both are correct — they are different features.
 * - ```` ```math ```` renders as display math; ```` ```latex ```` / ```` ```tex ````
 *   render as code blocks (raw TeX on purpose — the user asked to see it).
 */

/** How the case is supposed to come out the far end of the on-screen renderer. */
export type MathExpectation =
  /** At least one KaTeX node must be produced, and no KaTeX error. */
  | 'renders-math'
  /** No KaTeX at all; the source text must survive readable and verbatim. */
  | 'stays-literal'
  /**
   * Input the renderer cannot fully honour. "Gracefully" is asserted, not
   * hand-waved: the render must not throw, the author's characters must still
   * be on screen (nothing silently vanishes), and any KaTeX error span must be
   * non-empty so the reader can see what went wrong. See DEGRADATION_RULES.
   */
  | 'degrades';

/**
 * The four assertion families, so a documented gap can say WHICH of them it
 * breaks instead of silencing all four.
 */
export type ConformanceFamily = 'leak' | 'block-split' | 'streaming' | 'parity';

export type ConformanceGroup =
  | 'delimiters'
  | 'environments'
  | 'currency'
  | 'adjacency'
  | 'protected'
  | 'adversarial'
  | 'sentinels'
  | 'i18n'
  | 'issue-121';

export interface ConformanceCase {
  /** Stable id. Printed in every failure message; never renumber. */
  readonly id: string;
  /** Human label, read out loud in test names. */
  readonly label: string;
  readonly group: ConformanceGroup;
  /** Markdown as a model would emit it, BEFORE normalizeMathDelimiters. */
  readonly input: string;
  readonly expectation: MathExpectation;
  /**
   * Substrings that must appear in the rendered visible text. Use for content
   * that must survive a transformation (a citation marker next to an equation,
   * a price the normalizer escaped, a shell variable inside a code span).
   */
  readonly mustContainText?: readonly string[];
  /** Substrings that must never appear in the rendered visible text. */
  readonly mustNotContainText?: readonly string[];
  /**
   * The case must produce a `.katex-display` block, not an inline span.
   *
   * `renders-math` alone cannot express this — both are KaTeX nodes — yet the
   * difference is what the reader sees: centring, big-operator limits, and the
   * `.katex-display{overflow-x:auto}` scroller that keeps a wide derivation
   * inside the message bubble (`.katex .base` is `white-space: nowrap`, so an
   * inline span simply spills).
   */
  readonly mustBeDisplayMath?: boolean;
  /**
   * The case deliberately shows TeX source to the reader (a ```latex fence,
   * prose explaining `\[`). The leak detector then skips its code blocks —
   * but still scans everything outside them.
   */
  readonly rawTexIsIntentional?: boolean;
  /** A `degrades` case whose degradation legitimately includes a KaTeX error span. */
  readonly allowKatexError?: boolean;
  /**
   * Documented CURRENT gap, with the reason. The families it names run it as an
   * expected failure (`it.fails`), so the day someone closes the gap the suite
   * goes red and tells them to delete this field. Never add one to silence a
   * real bug — and never widen `knownGapFamilies` past what actually breaks.
   */
  readonly knownGap?: string;
  /** Families the gap breaks. Required whenever `knownGap` is set. */
  readonly knownGapFamilies?: readonly ConformanceFamily[];
  /** Skip the streaming replay (already a partial, or replay adds nothing). */
  readonly skipStreaming?: boolean;
}

const raw = String.raw;
/** Joins lines. Clearer than a flush-left template literal inside an object. */
const lines = (...parts: readonly string[]): string => parts.join('\n');
/** A fenced code block. A template literal cannot hold ``` without escaping. */
const fence = (lang: string, ...body: readonly string[]): string =>
  ['```' + lang, ...body, '```'].join('\n');

/**
 * What `degrades` promises the reader. Asserted by renderConformance; stated
 * here so the promise lives with the corpus rather than inside one spec file.
 */
export const DEGRADATION_RULES = [
  'the render must not throw',
  'the visible text must still contain the author’s own characters (nothing silently vanishes)',
  'any KaTeX error span must carry visible text, not an empty box',
] as const;

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  // ---------------------------------------------------------------- delimiters
  {
    id: 'delim-single-dollar-inline',
    label: 'single-dollar inline math is inert in this app',
    group: 'delimiters',
    input: 'Let $x$ be the number of kits.',
    expectation: 'stays-literal',
    mustContainText: ['$x$'],
  },
  {
    id: 'delim-double-dollar-inline',
    label: 'double-dollar inline math renders inline',
    group: 'delimiters',
    input: raw`The area $$A = \pi r^2$$ grows with the radius.`,
    expectation: 'renders-math',
  },
  {
    id: 'delim-double-dollar-display',
    label: 'double-dollar display block renders as display math',
    group: 'delimiters',
    input: lines('Result:', '', '$$', raw`\frac{a}{b}`, '$$', '', 'Done.'),
    expectation: 'renders-math',
    mustContainText: ['Result:', 'Done.'],
  },
  {
    id: 'delim-paren-inline',
    label: 'LaTeX \\( \\) inline delimiters (what GPT emits with no prompt)',
    group: 'delimiters',
    input: raw`The area \( A = \pi r^2 \) grows with the radius.`,
    expectation: 'renders-math',
  },
  {
    id: 'delim-bracket-display',
    label: 'LaTeX \\[ \\] display delimiters on one line',
    group: 'delimiters',
    input: lines('Answer:', '', raw`\[ \frac{a}{b} \]`, '', 'Done.'),
    expectation: 'renders-math',
    // `\[` MEANS display, so a one-line `$$…$$` — remark-math's INLINE
    // construct — is a silent demotion, not a fix.
    mustBeDisplayMath: true,
    mustContainText: ['Answer:', 'Done.'],
  },
  {
    id: 'delim-bracket-multiline',
    label: 'LaTeX \\[ \\] display delimiters spanning lines',
    group: 'delimiters',
    input: lines(raw`\[`, raw`\frac{a}{b}`, raw`\]`),
    expectation: 'renders-math',
    mustBeDisplayMath: true,
  },
  {
    id: 'delim-paren-adjacent',
    label: 'two \\( \\) spans in one sentence',
    group: 'delimiters',
    input: raw`Compare \(\alpha\) and \(\beta\) directly.`,
    expectation: 'renders-math',
  },
  {
    id: 'delim-math-fence',
    label: '```math fence renders as display math',
    group: 'delimiters',
    input: fence('math', 'E = mc^2'),
    expectation: 'renders-math',
  },
  {
    id: 'delim-latex-fence',
    label: '```latex fence stays source — the user asked to SEE the TeX',
    group: 'delimiters',
    input: fence('latex', raw`\frac{a}{b}`),
    expectation: 'stays-literal',
    rawTexIsIntentional: true,
    mustContainText: [raw`\frac{a}{b}`],
  },
  {
    id: 'delim-tex-fence',
    label: '```tex fence stays source',
    group: 'delimiters',
    input: fence('tex', raw`\begin{aligned} a &= b \end{aligned}`),
    expectation: 'stays-literal',
    rawTexIsIntentional: true,
  },

  // -------------------------------------------------------------- environments
  {
    id: 'env-aligned-blank-line',
    label: 'aligned with a blank line inside (the C3 block-split trigger)',
    group: 'environments',
    input: lines(
      'Here:',
      '',
      '$$',
      raw`\begin{aligned}`,
      raw`a &= b \\`,
      '',
      'c &= d',
      raw`\end{aligned}`,
      '$$',
      '',
      'Done.',
    ),
    expectation: 'renders-math',
    mustContainText: ['Here:', 'Done.'],
  },
  {
    id: 'env-aligned-no-blank-line',
    label: 'aligned, well formed (the shape everything else must reduce to)',
    group: 'environments',
    input: lines(
      '$$',
      raw`\begin{aligned}`,
      raw`a &= b \\`,
      'c &= d',
      raw`\end{aligned}`,
      '$$',
    ),
    expectation: 'renders-math',
  },
  {
    id: 'env-aligned-single-line-delims',
    label:
      'aligned with $$ hugging the environment (C3b: $$ meta is discarded)',
    group: 'environments',
    input: lines(
      raw`$$\begin{aligned}`,
      raw`a &= b \\`,
      'c &= d',
      raw`\end{aligned}$$`,
    ),
    expectation: 'renders-math',
  },
  {
    id: 'env-cases',
    label: 'cases environment',
    group: 'environments',
    input: lines(
      '$$',
      raw`\begin{cases}`,
      raw`a & x > 0 \\`,
      raw`b & x \le 0`,
      raw`\end{cases}`,
      '$$',
    ),
    expectation: 'renders-math',
  },
  {
    id: 'env-bmatrix-blank-line',
    label: 'bmatrix with a blank line inside',
    group: 'environments',
    input: lines(
      '$$',
      raw`\begin{bmatrix}`,
      raw`1 & 2 \\`,
      '',
      '3 & 4',
      raw`\end{bmatrix}`,
      '$$',
    ),
    expectation: 'renders-math',
  },
  {
    id: 'env-split',
    label: 'split environment',
    group: 'environments',
    input: lines(
      '$$',
      raw`\begin{split}`,
      raw`a &= b \\`,
      '&= c',
      raw`\end{split}`,
      '$$',
    ),
    expectation: 'renders-math',
  },
  {
    id: 'env-array-bracket-delims',
    label: 'array environment inside \\[ \\]',
    group: 'environments',
    input: lines(
      raw`\[`,
      raw`\begin{array}{cc}`,
      raw`1 & 2 \\`,
      '3 & 4',
      raw`\end{array}`,
      raw`\]`,
    ),
    expectation: 'renders-math',
  },
  {
    id: 'env-aligned-spaced-linebreak',
    label: 'aligned using \\\\[2pt] — a line break, NOT an opening \\[',
    group: 'environments',
    input: lines(
      '$$',
      raw`\begin{aligned}`,
      raw`a &= b \\[2pt]`,
      'c &= d',
      raw`\end{aligned}`,
      '$$',
    ),
    expectation: 'renders-math',
  },

  // ------------------------------------------------------------------ currency
  {
    id: 'currency-single-amount',
    label: 'one price in a sentence',
    group: 'currency',
    input: 'Each kit costs $5 to assemble.',
    expectation: 'stays-literal',
    mustContainText: ['$5'],
  },
  {
    id: 'currency-two-amounts',
    label: 'two prices in one paragraph (the classic false-math trigger)',
    group: 'currency',
    input: 'Budget is $5,000 for supplies and $12,000 for staff.',
    expectation: 'stays-literal',
    mustContainText: ['$5,000', '$12,000'],
  },
  {
    id: 'currency-price-range',
    label: 'a price range',
    group: 'currency',
    input: 'Prices range $10-$20 per unit.',
    expectation: 'stays-literal',
    mustContainText: ['$10', '$20'],
  },
  {
    id: 'currency-us-prefix',
    label: 'US$ with a space before the amount',
    group: 'currency',
    input: 'US$ 40 per kit and US$ 60 per crate.',
    expectation: 'stays-literal',
    mustContainText: ['US$ 40', 'US$ 60'],
  },
  {
    id: 'currency-with-real-math',
    label: 'a price and a real equation in the same sentence',
    group: 'currency',
    input: raw`We spent $5,000 on $$\alpha$$ testing.`,
    expectation: 'renders-math',
    mustContainText: ['$5,000'],
  },
  {
    id: 'currency-shell-var-in-prose',
    label: 'shell variables in prose, outside any code span',
    group: 'currency',
    input: 'Set $HOME and $PATH before running the importer.',
    expectation: 'stays-literal',
    mustContainText: ['$HOME', '$PATH'],
  },

  // ----------------------------------------------------------------- adjacency
  {
    id: 'adj-table-cell',
    label: 'math inside a GFM table cell',
    group: 'adjacency',
    input: lines(
      '| Indicator | Formula |',
      '| --- | --- |',
      raw`| MMR | $$\frac{a}{b}$$ |`,
    ),
    expectation: 'renders-math',
    mustContainText: ['Indicator', 'MMR'],
  },
  {
    id: 'adj-list-item-display',
    label: 'display math indented inside an ordered list item',
    group: 'adjacency',
    input: lines(
      '1. Compute the ratio:',
      '',
      '   $$',
      raw`   \frac{a}{b}`,
      '   $$',
      '',
      '2. Multiply by 100,000.',
    ),
    expectation: 'renders-math',
    mustContainText: ['Compute the ratio:'],
  },
  {
    id: 'adj-blockquote',
    label: 'display math inside a blockquote',
    group: 'adjacency',
    input: lines('> The ratio:', '>', '> $$', raw`> \frac{a}{b}`, '> $$'),
    expectation: 'renders-math',
  },
  {
    id: 'adj-heading',
    label: 'math inside a heading',
    group: 'adjacency',
    input: '## The identity $$E = mc^2$$ explained',
    expectation: 'renders-math',
    mustContainText: ['explained'],
  },
  {
    id: 'adj-citation-marker',
    label: 'math immediately before a [1] citation marker',
    group: 'adjacency',
    input: raw`The facility ratio $$\frac{a}{b}$$ [1] is the standard measure.`,
    expectation: 'renders-math',
    mustContainText: ['[1]'],
  },
  {
    id: 'adj-bold',
    label: 'math inside bold',
    group: 'adjacency',
    input: 'The result is **exactly $$x^2$$** in every case.',
    expectation: 'renders-math',
  },
  {
    id: 'adj-italic-subscript',
    label: 'underscore emphasis around math containing a subscript',
    group: 'adjacency',
    input: 'The _initial_ value $$x_1$$ and the _final_ value $$x_2$$.',
    expectation: 'renders-math',
  },
  {
    id: 'adj-link-text',
    label: 'math inside link text',
    group: 'adjacency',
    input: raw`See [the ratio $$\frac{a}{b}$$](https://example.org/mmr).`,
    expectation: 'renders-math',
  },
  {
    id: 'adj-link-title',
    label: 'math in a link TITLE attribute is not rendered (declared)',
    group: 'adjacency',
    input: '[the formula](https://example.org "$$x^2$$")',
    expectation: 'stays-literal',
    mustContainText: ['the formula'],
  },

  // ----------------------------------------------------------------- protected
  {
    id: 'prot-shell-fence',
    label: '$VAR inside a ```sh fence must not be escaped or typeset',
    group: 'protected',
    input: fence('sh', 'echo $HOME and $PATH'),
    expectation: 'stays-literal',
    mustContainText: ['echo $HOME and $PATH'],
  },
  {
    id: 'prot-inline-code-span',
    label: 'a code span with $VAR next to real math outside it',
    group: 'protected',
    input: 'Run `echo $HOME` and then compute $$y = 2x$$.',
    expectation: 'renders-math',
    mustContainText: ['echo $HOME'],
  },
  {
    id: 'prot-mermaid-fence',
    label: 'mermaid fence containing dollar signs',
    group: 'protected',
    input: fence('mermaid', 'flowchart TD', '  A["$5 and $6"] --> B'),
    expectation: 'stays-literal',
    mustContainText: ['$5 and $6'],
  },
  {
    id: 'prot-fence-with-tex-delims',
    label: 'a fence showing \\[ \\] as literal source',
    group: 'protected',
    input: fence('text', raw`\[ x = 1 \]`),
    expectation: 'stays-literal',
    rawTexIsIntentional: true,
    mustContainText: [raw`\[ x = 1 \]`],
  },
  {
    id: 'prot-indented-code',
    label: 'four-space indented code block with $VAR',
    group: 'protected',
    input: lines('Example:', '', '    echo $HOME and $PATH', ''),
    expectation: 'stays-literal',
    mustContainText: ['echo $HOME and $PATH'],
  },

  // --------------------------------------------------------------- adversarial
  {
    id: 'adv-lone-dollar',
    label: 'a single unpaired dollar sign in prose',
    group: 'adversarial',
    input: 'A lone $ sign should stay a dollar sign.',
    expectation: 'stays-literal',
    mustContainText: ['$ sign'],
  },
  {
    id: 'adv-unterminated-display-own-line',
    label: 'a truncated response ending mid display-math, TeX on its own line',
    group: 'adversarial',
    input: lines('Truncated:', '', '$$', raw`\frac{a}{b}`),
    expectation: 'renders-math',
    mustContainText: ['Truncated:'],
    knownGap:
      'The screen typesets this (micromark runs an unterminated `$$` to the end of ' +
      'input), but `toSpeakableText` only rewrites TERMINATED regions — the same ' +
      'streaming-safety rule the normalizer follows — so a truncated message hands ' +
      'its raw TeX to the speech synthesizer. Closing it means teaching the speakable ' +
      'pass about unterminated regions without regressing mid-stream churn.',
    knownGapFamilies: ['parity'],
    skipStreaming: true,
  },
  {
    id: 'adv-unterminated-display-hugging',
    label: 'a truncated response whose TeX sits on the opening $$ line',
    group: 'adversarial',
    input: lines('Truncated:', '', raw`$$\frac{a}{b}`),
    expectation: 'degrades',
    allowKatexError: true,
    knownGap:
      'micromark-extension-math treats whatever follows an opening `$$` as a fenced-code-' +
      'style INFO STRING and discards it, so an unterminated `$$\\frac{a}{b}` renders as a ' +
      'silent EMPTY equation box — the author’s characters vanish with no error shown. ' +
      'The normalizer deliberately leaves unterminated regions untouched (streaming safety), ' +
      'so closing this gap needs a render-layer change rather than a string one. ' +
      'The speech path drops it for the same reason `adv-unterminated-display-own-line` ' +
      'does: only terminated regions are rewritten.',
    knownGapFamilies: ['leak', 'parity'],
    skipStreaming: true,
  },
  {
    id: 'adv-bracket-no-close',
    label: 'an opening \\[ with no \\] — must NOT be converted',
    group: 'adversarial',
    input: raw`The array notation \[ is introduced later in the guide.`,
    expectation: 'stays-literal',
    mustContainText: ['is introduced later in the guide'],
  },
  {
    id: 'adv-escaped-bracket-prose',
    label: 'prose ABOUT \\[ and \\] must not become math',
    group: 'adversarial',
    input: raw`In LaTeX you write \[ and \] to open and close display math.`,
    expectation: 'stays-literal',
    mustContainText: ['to open and close display math'],
  },
  {
    id: 'adv-unknown-macro',
    label: 'an unknown TeX macro',
    group: 'adversarial',
    input: raw`$$\foobarbaz{x}$$`,
    expectation: 'degrades',
    knownGap:
      'Streamdown pins rehype-katex with an errorColor, so KaTeX prints ' +
      '`\foobarbaz` onto the page in a muted colour instead of raising a ' +
      '.katex-error: the reader sees raw TeX with nothing marking it as broken, ' +
      'and katexErrors is empty so allowKatexError and the degradation rules ' +
      'assert nothing. Closing it means overriding the rehype-katex options in ' +
      'MATH_REHYPE_PLUGINS so an unsupported command degrades visibly.',
    knownGapFamilies: ['leak'],
  },
  {
    // `%` opens a comment in TeX and KaTeX honours it, so the rest of the line
    // is discarded — with katexCount 1, katexErrors [] and a NON-empty
    // annotation, which is why every existing guard passes over it.
    id: 'adv-percent-inline',
    label: 'a bare % in inline math truncates the rest of the line',
    group: 'adversarial',
    input: raw`The coverage is $$45%$$ of target.`,
    expectation: 'renders-math',
    mustContainText: ['45%'],
    knownGap:
      'this renders as "The coverage is 45 of target" — a rate silently shown ' +
      'as a bare count, with no error and no empty box to signal it. Closing ' +
      'it needs a production change (escaping a bare `%` inside `$$…$$` in ' +
      'normalizeMathDelimiters, and/or a `\\%` bullet in the system prompt), ' +
      'not a corpus change. `$$45\\%$$` is the correct authoring form and ' +
      'renders "45%" today.',
    knownGapFamilies: ['leak'],
  },
  {
    id: 'adv-percent-swallows-row-break',
    label: 'a bare % eats the \\\\ row break and merges two rows',
    group: 'adversarial',
    input: lines('$$', raw`\text{rate} = 50% \\`, raw`\text{other} = 2`, '$$'),
    expectation: 'renders-math',
    mustContainText: ['50%', 'other'],
    knownGap:
      'the comment runs to end of line, so it takes the `\\\\` row break with ' +
      'it: two rows of a derivation render as the single row "rate=50other=2" ' +
      'inside a clean-looking katex-display, with nothing to warn the reader.',
    knownGapFamilies: ['leak'],
  },

  // `\[` / `\]` is also markdown's own escape for a literal bracket, so these
  // are prose whose brackets the author kept on purpose. Converting one DELETES
  // them: measured, `\[a-z\]` rendered as `a−z`, `\[2\]` as `2`.
  {
    id: 'adv-escaped-bracket-char-class',
    label: 'a regex character class keeps its brackets',
    group: 'adversarial',
    input: raw`The character class \[a-z\] matches lowercase letters.`,
    expectation: 'stays-literal',
    mustContainText: ['[a-z]'],
  },
  {
    id: 'adv-escaped-bracket-citation',
    label: 'a citation marker keeps its brackets',
    group: 'adversarial',
    input: raw`See the report \[1\] and the annex \[2\].`,
    expectation: 'stays-literal',
    mustContainText: ['[1]', '[2]'],
  },
  {
    id: 'adv-escaped-bracket-placeholder',
    label: 'a form placeholder keeps its brackets',
    group: 'adversarial',
    input: raw`Replace \[site 1\] and mark it \[ok\] in the form.`,
    expectation: 'stays-literal',
    mustContainText: ['[site 1]', '[ok]'],
  },
  {
    id: 'adv-escaped-paren-range',
    label: 'a numeric range keeps its parentheses',
    group: 'adversarial',
    input: raw`The acceptable range \(0-10\) is documented.`,
    expectation: 'stays-literal',
    mustContainText: ['(0-10)'],
  },

  // An unpaired opener must not reach across a paragraph break for an
  // unrelated closer. Measured before the bound: the paragraphs fused, a
  // literal `$$` appeared, and the clause after the false closer was DELETED.
  {
    id: 'adv-unpaired-bracket-across-paragraphs',
    label: 'an unpaired \\[ does not pair with a \\] two paragraphs later',
    group: 'adversarial',
    // The second paragraph carries `x = 1` on purpose: without it the region
    // would be rejected by mathPlausible anyway and this case would prove
    // nothing about the paragraph bound it exists to pin.
    input: lines(
      raw`To show a literal bracket, type \[ in your document.`,
      '',
      raw`In section 2, where x = 1, we explain how \] behaves.`,
    ),
    expectation: 'stays-literal',
    mustContainText: ['in your document', 'we explain how'],
  },
  {
    id: 'adv-dropped-closer-across-paragraphs',
    label: 'a dropped closer does not swallow the paragraphs after it',
    group: 'adversarial',
    // No TeX command in the body on purpose: an unterminated region is copied
    // through verbatim (streaming safety), so a `\pi` here would legitimately
    // reach the reader as prose and this case would be arguing about that
    // instead of about the paragraph bound it exists to pin.
    input: lines(
      raw`The area is \[ A = 2 r^2 and that is all.`,
      '',
      'Next paragraph has a - dash in it.',
      '',
      raw`Later we write \] by mistake.`,
    ),
    expectation: 'stays-literal',
    mustContainText: ['Next paragraph has a - dash in it', 'by mistake'],
  },

  {
    id: 'adv-deep-braces',
    label: 'deeply nested braces',
    group: 'adversarial',
    input: raw`$$\frac{\frac{\frac{a}{b}}{c}}{d}$$`,
    expectation: 'renders-math',
  },
  {
    id: 'adv-long-single-line',
    label: 'a very long single-line formula',
    group: 'adversarial',
    input:
      '$$' +
      raw`\sum_{i=1}^{n} \left( \frac{x_i - \mu}{\sigma} \right)^2 + \int_0^\infty e^{-t^2} \, dt - \prod_{k=1}^{m} \left( 1 - \frac{1}{p_k} \right) + \lim_{h \to 0} \frac{f(x+h) - f(x)}{h}` +
      '$$',
    expectation: 'renders-math',
  },
  {
    id: 'adv-mismatched-braces',
    label: 'unbalanced braces inside otherwise valid delimiters',
    group: 'adversarial',
    input: raw`$$\frac{a}{b$$`,
    expectation: 'degrades',
    allowKatexError: true,
  },

  // ------------------------------------------------------------------ sentinels
  {
    id: 'sentinel-metadata-block',
    label: 'a metadata sentinel carrying dollar signs, next to real math',
    group: 'sentinels',
    input: lines(
      raw`The unit cost is $$c = 5$$.`,
      '',
      '<<<METADATA_START>>>{"note":"$5 and $6"}<<<METADATA_END>>>',
    ),
    expectation: 'renders-math',
    mustContainText: ['$5 and $6'],
  },
  {
    id: 'sentinel-agent-activity',
    label: 'an agent-activity sentinel must pass through untouched',
    group: 'sentinels',
    input: lines(
      raw`<<<AGENT_ACTIVITY>>>{"tool":"search","q":"cost of $5 kits"}<<<END_AGENT_ACTIVITY>>>`,
      '',
      raw`Result: $$x^2$$`,
    ),
    expectation: 'renders-math',
    mustContainText: ['cost of $5 kits'],
  },

  // A fence legally opens inside a container. Leaving those unprotected let
  // rule 4 write a visible `\$` into a code block — permanently for a `~~~`
  // fence, which no later backtick run can accidentally rescue.
  {
    id: 'protected-tilde-fence-in-quote',
    label: 'a tilde fence inside a blockquote protects its dollars',
    group: 'protected',
    input: lines('> ~~~sh', '> echo $5,000 and $3,000', '> ~~~'),
    expectation: 'stays-literal',
    mustContainText: ['echo $5,000 and $3,000'],
    mustNotContainText: [raw`\$5,000`],
  },
  {
    id: 'protected-fence-on-list-marker-line',
    label: 'a fence on a list-marker line, still streaming',
    group: 'protected',
    input: lines('- ```bash', '  echo $HOME and $PATH'),
    expectation: 'stays-literal',
    mustContainText: ['echo $HOME and $PATH'],
    mustNotContainText: [raw`\$HOME`],
  },
  {
    // GFM's literal-autolink extension does not process backslash escapes, so
    // an escape added here survives into the href as `%5C` — a 404 — and shows
    // as a stray backslash in the link text.
    id: 'currency-inside-bare-url',
    label: 'a $ inside a bare URL is part of the link, not currency',
    group: 'currency',
    input: 'See https://ex.com/report?amt=$1,000 and the budget is $5,000.',
    expectation: 'stays-literal',
    mustContainText: ['https://ex.com/report?amt=$1,000', '$5,000'],
    mustNotContainText: ['%5C', raw`\$1,000`],
  },

  // ----------------------------------------------------------------------- i18n
  {
    id: 'i18n-cjk-spaced',
    label: 'CJK text with spaces around the math',
    group: 'i18n',
    input: raw`面积为 $$A = \pi r^2$$ 的圆。`,
    expectation: 'renders-math',
    mustContainText: ['面积为'],
  },
  {
    id: 'i18n-cjk-unspaced',
    label: 'CJK text with NO spaces around the math',
    group: 'i18n',
    input: raw`面积为$$A = \pi r^2$$的圆。`,
    expectation: 'renders-math',
    mustContainText: ['的圆'],
  },
  {
    id: 'i18n-rtl-arabic',
    label: 'an RTL paragraph containing display math',
    group: 'i18n',
    input: lines('النسبة السنوية هي:', '', '$$', raw`\frac{a}{b}`, '$$'),
    expectation: 'renders-math',
    mustContainText: ['النسبة السنوية'],
  },
  {
    id: 'i18n-french-trailing-currency',
    label: 'French writes the sigil AFTER the amount',
    group: 'i18n',
    input: 'Le budget est de 5 000 $ par mois et de 60 000 $ par an.',
    expectation: 'stays-literal',
    mustContainText: ['5 000 $', '60 000 $'],
  },

  // ------------------------------------------------------------------ issue-121
  {
    id: 'issue121-facility-mmr-bracket',
    label: 'issue #121: Facility MMR in \\[ \\] delimiters (as GPT emits it)',
    group: 'issue-121',
    input: lines(
      'Facility-based maternal mortality ratio:',
      '',
      raw`\[ \text{Facility MMR} = \frac{\text{Number of maternal deaths in the facility}}{\text{Number of live births in the facility}} \times 100{,}000 \]`,
      '',
      'This is similar in structure to the general MMR.',
    ),
    expectation: 'renders-math',
    mustBeDisplayMath: true,
    mustContainText: [
      'Facility-based maternal mortality ratio:',
      'similar in structure',
    ],
  },
  {
    id: 'issue121-facility-mmr-display',
    label: 'issue #121: the same formula in the delimiters we ask models for',
    group: 'issue-121',
    input: lines(
      'Facility-based maternal mortality ratio:',
      '',
      '$$',
      raw`\text{Facility MMR} = \frac{\text{Number of maternal deaths in the facility}}{\text{Number of live births in the facility}} \times 100{,}000`,
      '$$',
    ),
    expectation: 'renders-math',
  },
  {
    id: 'issue121-obstetric-ratio-inline',
    label: 'issue #121: second formula, \\text{ or } inside the expression',
    group: 'issue-121',
    input: raw`Maternal death among obstetric admissions: \[\frac{\text{Maternal deaths}}{\text{Obstetric admissions}} \times 100 \text{ or } 1{,}000\]`,
    expectation: 'renders-math',
  },
  {
    id: 'issue121-formula-with-budget-prose',
    label: 'issue #121 shape plus a budget figure in the same message',
    group: 'issue-121',
    input: lines(
      'The supply line costs $12,000 per facility. The ratio is:',
      '',
      '$$',
      raw`\text{MMR} = \frac{D}{B} \times 100{,}000`,
      '$$',
      '',
      'Compare that against the $5,000 baseline.',
    ),
    expectation: 'renders-math',
    mustContainText: ['$12,000', '$5,000'],
  },
];

/** Renderers the parity matrix covers. */
export type RendererId = 'screen' | 'export' | 'tts';

export type RendererSupport =
  /** The renderer conveys the feature. */
  | 'supported'
  /**
   * The renderer cannot convey it and downgrades ON PURPOSE, in a way stated
   * in `note` and asserted by rendererParity. Silent divergence is the bug
   * this value exists to distinguish from.
   */
  | 'declared-downgrade';

export interface ParityRow {
  /** Feature label, e.g. 'display math'. */
  readonly feature: string;
  /** A `CONFORMANCE_CASES` id used as the probe for this row. */
  readonly caseId: string;
  readonly screen: RendererSupport;
  readonly export: RendererSupport;
  /** What the export downgrade IS, in one line. Required for a downgrade. */
  readonly exportNote: string;
  readonly tts: RendererSupport;
  readonly ttsNote: string;
  /**
   * A substring the spoken text must contain — the downgrade made concrete.
   * `'equation'` is the placeholder for an expression too structured to say;
   * anything else is the verbalization (`\frac{a}{b}` → "a over b").
   */
  readonly ttsSpoken?: string;
}

/**
 * Feature × renderer matrix. Every cell is an explicit promise; the parity
 * spec turns each into an assertion, so a renderer that quietly stops honouring
 * its promise fails rather than drifting.
 *
 * The export column encodes what `markdownToHtml` (marked, no math extension)
 * promises: it cannot typeset, so the honest contract is that the TeX SOURCE
 * survives verbatim and recoverable — `$$\frac{a}{b}$$` reaches Word, Obsidian
 * or Pandoc intact. `\[ \frac{a}{b} \]` does NOT: marked eats the backslashes
 * and the delimiters are gone forever, which is exactly the divergence the
 * normalizer removes by running on the export path too.
 */
export const RENDERER_PARITY_MATRIX: readonly ParityRow[] = [
  {
    feature: 'display math',
    caseId: 'delim-double-dollar-display',
    screen: 'supported',
    export: 'declared-downgrade',
    exportNote:
      'marked has no math extension; the $$…$$ source survives verbatim so the reader (or Pandoc/Obsidian/GitHub) can still resolve it',
    tts: 'declared-downgrade',
    ttsNote:
      'not typeset; a simple expression is VERBALIZED (\\frac{a}{b} → "a over b") and anything too structured falls back to a spoken placeholder — never read out as backslash-frac',
    ttsSpoken: 'a over b',
  },
  {
    feature: 'inline math',
    caseId: 'delim-double-dollar-inline',
    screen: 'supported',
    export: 'declared-downgrade',
    exportNote: 'same as display math: source survives, no typesetting',
    tts: 'declared-downgrade',
    ttsNote: 'verbalized, same contract as display math',
    ttsSpoken: 'A equals pi r squared',
  },
  {
    feature: 'LaTeX \\[ \\] delimiters',
    caseId: 'issue121-facility-mmr-bracket',
    screen: 'supported',
    export: 'declared-downgrade',
    exportNote:
      'normalized to $$…$$ BEFORE marked sees it — without that, marked eats the backslashes and the delimiters are unrecoverable',
    tts: 'declared-downgrade',
    ttsNote:
      'the \\[ \\] region is recognised and spoken like any other; this formula is too structured to verbalize, so it becomes the placeholder',
    ttsSpoken: 'equation',
  },
  {
    feature: 'multi-line environment (aligned)',
    caseId: 'env-aligned-blank-line',
    screen: 'supported',
    export: 'declared-downgrade',
    exportNote: 'source survives verbatim, on its own lines',
    tts: 'declared-downgrade',
    ttsNote:
      'an aligned derivation cannot be said in a sentence, so it becomes the placeholder rather than a wall of commands',
    ttsSpoken: 'equation',
  },
  {
    feature: 'currency in prose',
    caseId: 'currency-two-amounts',
    screen: 'supported',
    export: 'supported',
    exportNote: 'marked unescapes \\$ back to $, so prices read correctly',
    tts: 'supported',
    ttsNote: 'prices are ordinary text and are spoken as written',
  },
  {
    feature: 'code fence containing $',
    caseId: 'prot-shell-fence',
    screen: 'supported',
    export: 'supported',
    exportNote: 'fence content is passed through untouched',
    tts: 'declared-downgrade',
    ttsNote:
      'the speakable pass copies fences through untouched and cleanMarkdown only removes the backticks, so code IS read aloud as words — noted here because it is a real divergence from the screen, not because it is wrong',
    ttsSpoken: 'echo $HOME and $PATH',
  },
  {
    feature: 'issue #121 regression shape',
    caseId: 'issue121-facility-mmr-display',
    screen: 'supported',
    export: 'declared-downgrade',
    exportNote: 'source survives verbatim',
    tts: 'declared-downgrade',
    ttsNote: 'too structured to verbalize; becomes the placeholder',
    ttsSpoken: 'equation',
  },
];
