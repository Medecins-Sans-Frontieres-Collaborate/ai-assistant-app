/**
 * FAMILY 2 — BLOCK-SPLIT INVARIANT.
 *
 * Streamdown does not hand the whole message to one markdown parse. In
 * `mode="streaming"` (its default, and what a live message uses) it first runs
 * `parseMarkdownIntoBlocks` — a `marked` lexer that splits on blank lines with
 * no knowledge of math — and then parses EACH BLOCK INDEPENDENTLY. A `$$`
 * region that straddles a blank line is therefore cut in half before
 * remark-math ever sees it: block one ends mid-environment and renders a red
 * `ParseError`, block two starts with an orphaned `\end{aligned}`.
 *
 * That is defect C3 of issue #121, and it reproduces with no model involved.
 * The invariant asserted here is the general form of it:
 *
 *     render(normalize(doc))  ≡  Σ render(block) over parseMarkdownIntoBlocks(normalize(doc))
 *
 * Hold that for every corpus case and C3 cannot come back — not for `aligned`,
 * not for `cases`, not for whatever environment a model invents next.
 *
 * WHAT "≡" MEANS (see `signatureOf` in renderPipelines.ts)
 * -------------------------------------------------------
 * Not HTML string identity. Rendering a document whole and rendering it
 * block-by-block legitimately differ in inter-element whitespace — remark-rehype
 * inserts `\n` text nodes between siblings that per-block rendering never
 * creates — and could differ in generated ids. What must NOT differ is what the
 * reader receives: the same TeX expressions in the same order, the same number
 * of KaTeX errors, and the same words, whitespace-collapsed.
 */
import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import { CONFORMANCE_CASES } from '../../fixtures/markdown/conformanceCases';
import {
  renderBlocks,
  renderScreen,
  signatureOf,
  signatureOfBlocks,
} from './renderPipelines';

import { parseMarkdownIntoBlocks } from 'streamdown';
import { describe, expect, it } from 'vitest';

describe('block-split invariant', () => {
  for (const testCase of CONFORMANCE_CASES) {
    const name = `${testCase.id} — ${testCase.label}`;
    const run = (): void => {
      const normalized = normalizeMathDelimiters(testCase.input);
      const whole = renderScreen(normalized);
      const { blocks, perBlock } = renderBlocks(normalized, {
        withRemend: false,
      });

      const wholeSignature = signatureOf(whole);
      const blockSignature = signatureOfBlocks(perBlock);

      const context = [
        `case: ${testCase.id}`,
        `normalized:\n${normalized}`,
        `blocks (${blocks.length}): ${JSON.stringify(blocks)}`,
        `whole render : ${JSON.stringify(wholeSignature)}`,
        `block renders: ${JSON.stringify(blockSignature)}`,
        '',
        'Streamdown parses each block on its own, so a math region that lands in',
        'two blocks is two broken equations on screen. Normalization must keep',
        'every `$$` region inside a single block.',
      ].join('\n');

      expect(blockSignature, context).toEqual(wholeSignature);
    };

    if (testCase.knownGapFamilies?.includes('block-split')) {
      it.fails(`[known gap] ${name}`, run);
    } else {
      it(name, run);
    }
  }
});

describe('no math region straddles a block boundary', () => {
  // The invariant above compares renders, which is the assertion that matters.
  // This is the direct structural statement of the same thing, so a failure
  // says WHICH block boundary is wrong instead of only that output differs.
  const unescapedDoubleDollars = (block: string): number => {
    let count = 0;
    for (let i = 0; i < block.length - 1; i += 1) {
      if (block[i] !== '$' || block[i + 1] !== '$') continue;
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && block[j] === '\\'; j -= 1) backslashes += 1;
      if (backslashes % 2 === 0) {
        count += 1;
        i += 1;
      }
    }
    return count;
  };

  for (const testCase of CONFORMANCE_CASES) {
    const run = (): void => {
      const normalized = normalizeMathDelimiters(testCase.input);
      // An odd total means the DOCUMENT itself is truncated (a cut-off stream),
      // not that a block boundary cut an equation. Parity only says something
      // about splitting when the whole is balanced to begin with.
      if (unescapedDoubleDollars(normalized) % 2 === 1) return;
      const blocks = parseMarkdownIntoBlocks(normalized);
      const straddling = blocks.filter(
        (block) => unescapedDoubleDollars(block) % 2 === 1,
      );
      expect(
        straddling,
        [
          `case: ${testCase.id}`,
          `normalized:\n${normalized}`,
          `blocks: ${JSON.stringify(blocks)}`,
          'A block holding an ODD number of `$$` has an equation cut in half.',
        ].join('\n'),
      ).toEqual([]);
    };

    if (testCase.knownGapFamilies?.includes('block-split')) {
      it.fails(`[known gap] ${testCase.id} — ${testCase.label}`, run);
    } else {
      it(`${testCase.id} — ${testCase.label}`, run);
    }
  }
});

describe('the defect this invariant guards, pinned', () => {
  // A characterization test, not an aspiration: this is Streamdown 1.6.11's
  // behaviour on UNNORMALIZED input. If a Streamdown upgrade ever teaches the
  // splitter about `$$`, this test fails and the normalizer's Rule 3 can be
  // reconsidered. (Streamdown does carry a `$$`-rejoin heuristic, but it only
  // fires for a block whose raw content trims to exactly `$$`.)
  const withBlankLine = [
    'Here:',
    '',
    '$$',
    '\\begin{aligned}',
    'a &= b \\\\',
    '',
    'c &= d',
    '\\end{aligned}',
    '$$',
    '',
    'Done.',
  ].join('\n');

  it('splits a blank-line `aligned` block apart before any math parser runs', () => {
    const blocks = parseMarkdownIntoBlocks(withBlankLine);
    const mathBlocks = blocks.filter((block) => block.includes('$$'));
    expect(mathBlocks.length, JSON.stringify(blocks)).toBeGreaterThan(1);
  });

  it('and that split produces a KaTeX error plus an orphaned \\end{aligned}', () => {
    const { perBlock } = renderBlocks(withBlankLine, { withRemend: false });
    const errors = perBlock.flatMap((block) => block.katexErrors);
    const text = perBlock.map((block) => block.proseText).join('');
    expect(errors.length).toBeGreaterThan(0);
    expect(text).toContain('\\end{aligned}');
  });

  it('normalization collapses it back into exactly one block', () => {
    const normalized = normalizeMathDelimiters(withBlankLine);
    const mathBlocks = parseMarkdownIntoBlocks(normalized).filter((block) =>
      block.includes('$$'),
    );
    expect(mathBlocks.length, normalized).toBe(1);
  });
});
