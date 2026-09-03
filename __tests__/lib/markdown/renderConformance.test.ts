/**
 * FAMILY 1 — LEAK DETECTOR.
 *
 * Every corpus case goes through `normalizeMathDelimiters` and then through the
 * real on-screen chain (Streamdown's own remark/rehype tuples, up to and
 * including KaTeX). One question is asked of the result: could a reader be
 * looking at LaTeX source, an empty box, or a red error where an equation
 * belongs? Issue #121 is a single `false` in this file.
 *
 * The rules are deliberately uniform, so a NEW case is one object literal in
 * `CONFORMANCE_CASES` and needs no new test code:
 *
 *   every case        no throw; no KaTeX node with an empty TeX annotation
 *                     (an empty box means the author's content vanished);
 *                     every KaTeX error span carries a message AND its source
 *                     text (a silent red box is not graceful degradation);
 *                     no LEAK_TOKENS in prose; mustContain/mustNotContain hold.
 *   renders-math      at least one KaTeX node, zero KaTeX errors.
 *   stays-literal     zero KaTeX nodes, zero errors — the source stands as
 *                     written (this is how a ```latex fence, a shell $VAR and
 *                     a budget figure all stay themselves).
 *   degrades          errors allowed only when the case says allowKatexError.
 *
 * "Prose" excludes code/pre and KaTeX error spans: TeX inside a fence is there
 * on purpose, and an error span echoing its own source is the degradation
 * working rather than a leak.
 */
import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import {
  CONFORMANCE_CASES,
  ConformanceCase,
  DEGRADATION_RULES,
} from '../../fixtures/markdown/conformanceCases';
import {
  LEAK_TOKENS,
  describeRender,
  findLeaks,
  renderScreen,
  renderWithStockSanitize,
  renderWithoutSanitize,
} from './renderPipelines';

import { describe, expect, it } from 'vitest';

const check = (testCase: ConformanceCase): void => {
  const normalized = normalizeMathDelimiters(testCase.input);
  const analysis = renderScreen(normalized);
  const context = (note: string): string =>
    `${note}\n${describeRender(testCase.id, testCase.input, analysis, {
      normalized,
      expectation: testCase.expectation,
    })}`;

  // --- universal: nothing silently vanishes -------------------------------
  // A `.katex` node whose TeX annotation is empty is an equation-shaped hole
  // in the page. It is worse than a visible error because nothing signals it.
  const emptyBoxes = analysis.texAnnotations.filter((tex) => tex.trim() === '');
  expect(
    emptyBoxes.length,
    context(
      'rendered an EMPTY equation box — the source characters vanished with no error shown',
    ),
  ).toBe(0);

  // --- universal: an error, if allowed, must be legible --------------------
  for (const error of analysis.katexErrors) {
    expect(
      error.title.length,
      context('a KaTeX error span carries no message'),
    ).toBeGreaterThan(0);
    expect(
      error.text.trim().length,
      context(
        `a KaTeX error span shows the reader nothing. Degradation must satisfy: ${DEGRADATION_RULES.join('; ')}`,
      ),
    ).toBeGreaterThan(0);
  }

  // --- universal: no raw TeX in prose -------------------------------------
  // `proseText` already excludes code/pre, so TeX inside a fence never counts.
  const leaks = findLeaks(analysis.proseText);
  expect(
    leaks,
    context(
      `raw LaTeX reached the reader as prose (leak tokens: ${LEAK_TOKENS.join(' ')})`,
    ),
  ).toEqual([]);

  // The flip side, so `rawTexIsIntentional` is a real assertion and not a
  // silencer: a case that promises to SHOW TeX must still be showing it.
  if (testCase.rawTexIsIntentional) {
    expect(
      findLeaks(analysis.visibleText),
      context(
        'this case exists to prove TeX shown on purpose survives — but none reached the page',
      ),
    ).not.toEqual([]);
  }

  // --- per-expectation ----------------------------------------------------
  if (testCase.expectation === 'renders-math') {
    expect(
      analysis.katexCount,
      context(
        'expected an equation, got none. If the normalizer emitted `$…$`, note that this ' +
          'app pins remark-math with singleDollarTextMath:false — only `$$…$$` renders.',
      ),
    ).toBeGreaterThan(0);
    expect(
      analysis.katexErrors,
      context('an equation that should render cleanly produced a KaTeX error'),
    ).toEqual([]);
  }

  if (testCase.expectation === 'stays-literal') {
    expect(
      analysis.katexCount,
      context(
        'text that must stay literal was typeset as math (a price, a shell variable, ' +
          'or source the user explicitly asked to SEE)',
      ),
    ).toBe(0);
    expect(
      analysis.katexErrors,
      context('literal text produced a KaTeX error'),
    ).toEqual([]);
  }

  if (testCase.expectation === 'degrades' && !testCase.allowKatexError) {
    expect(
      analysis.katexErrors,
      context('degradation produced a KaTeX error this case does not allow'),
    ).toEqual([]);
  }

  // --- per-case content -----------------------------------------------------
  for (const needle of testCase.mustContainText ?? []) {
    expect(
      analysis.visibleText.includes(needle),
      context(
        `rendered text lost the required substring ${JSON.stringify(needle)}`,
      ),
    ).toBe(true);
  }
  for (const needle of testCase.mustNotContainText ?? []) {
    expect(
      analysis.visibleText.includes(needle),
      context(
        `rendered text contains the forbidden substring ${JSON.stringify(needle)}`,
      ),
    ).toBe(false);
  }
};

describe('markdown conformance — leak detector', () => {
  for (const testCase of CONFORMANCE_CASES) {
    const name = `${testCase.id} — ${testCase.label}`;
    if (testCase.knownGap) {
      // Documented gap. `it.fails` means the day someone closes it this test
      // goes red and tells them to delete the `knownGap` field.
      it.fails(`[known gap] ${name}`, () => check(testCase));
    } else {
      it(name, () => check(testCase));
    }
  }
});

describe('normalizeMathDelimiters is idempotent over the corpus', () => {
  // It runs on both the render path and the export path, and export content is
  // sometimes assembled from already-rendered pieces, so double application
  // must be a no-op. A second `\` in front of a `$` would corrupt real prose.
  for (const testCase of CONFORMANCE_CASES) {
    it(`${testCase.id} — normalize(normalize(x)) === normalize(x)`, () => {
      const once = normalizeMathDelimiters(testCase.input);
      const twice = normalizeMathDelimiters(once);
      expect(
        twice,
        `case: ${testCase.id}\nfirst pass:\n${once}\nsecond pass:\n${twice}`,
      ).toBe(once);
    });
  }
});

describe('the sanitize step is where rendered equations live or die', () => {
  // The single highest-value regression test in this file, and the one whose
  // failure explains all the others.
  //
  // Streamdown's default rehype chain is {raw, katex, sanitize, harden} with
  // schema `{}` — sanitize runs AFTER katex and strips every katex* class,
  // unwraps all MathML, and drops KaTeX's inline styles. What is left is the
  // MathML text, then the <annotation> TeX, then the katex-html text,
  // concatenated: character for character the string the reporter of issue #121
  // pasted. No delimiter normalization and no CSS can repair that, because the
  // classes never reach the DOM. `MATH_REHYPE_PLUGINS` re-arms that one step.
  //
  // If every case in this file is failing, run these three first: they say
  // whether the math is wrong or the sanitizer ate it.
  const displayMath = '$$\\frac{a}{b}$$';

  it('KaTeX itself renders the equation (no sanitize step)', () => {
    const bare = renderWithoutSanitize(displayMath);
    expect(bare.katexCount, bare.html).toBeGreaterThan(0);
    expect(bare.texAnnotations).toEqual(['\\frac{a}{b}']);
  });

  it("Streamdown's stock sanitize schema destroys that output", () => {
    const stock = renderWithStockSanitize(displayMath);
    expect(stock.katexCount, stock.html).toBe(0);
    expect(stock.html).not.toContain('katex');
    // The annotation TeX survives as bare prose — the visible symptom.
    expect(stock.visibleText).toContain('\\frac{a}{b}');
  });

  it('the app chain (MATH_REHYPE_PLUGINS) keeps classes, MathML and styles', () => {
    const safe = renderScreen(displayMath);
    expect(safe.katexCount, safe.html).toBeGreaterThan(0);
    expect(safe.html).toContain('class="katex"');
    expect(safe.html).toContain('<math');
    expect(safe.html).toContain('style="');
    // The TeX is inside <annotation> where it belongs, not loose in prose.
    expect(safe.proseText).not.toContain('\\frac');
  });
});
