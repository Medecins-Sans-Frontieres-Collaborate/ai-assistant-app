/**
 * FAMILY 3 — STREAMING MONOTONICITY.
 *
 * A message is not rendered once; it is rendered on every chunk. In
 * `mode="streaming"` Streamdown splits the partial text into blocks and runs
 * `remend` over each one, which auto-CLOSES whatever is dangling: a half-typed
 * `$$\frac{\te` becomes `$$\frac{\te$$` and is handed to KaTeX, which throws a
 * red error span that changes with every token. Worse, remend reads a dangling
 * `\[` as an incomplete markdown LINK and appends the literal marker
 * `](streamdown:incomplete-link)` — so an agent emitting `\[ \frac{a` prints
 * that string on screen mid-answer.
 *
 * This family replays every corpus case one chunk at a time through that exact
 * machinery and asserts three things:
 *
 *   1. remend's incomplete-link marker never reaches the reader. Normalization
 *      must have already turned `\[ … \]` into `$$ … $$` by the time remend
 *      looks at it.
 *   2. A SETTLED frame renders cleanly — no KaTeX error, no empty equation box.
 *      "Settled" is remend's own judgement: it changed nothing, so the markdown
 *      is complete, and complete markdown has no excuse for showing an error.
 *      This is the assertion that matters, because the alternative ("no errors
 *      ever") is unachievable: an equation that has only half arrived cannot be
 *      typeset, and a transient error there is honest.
 *   3. The last frame equals the static render. Whatever the stream did on the
 *      way, the finished message must be identical to the same content parsed
 *      in one pass — which is what `mode="static"` gives a finished message.
 *
 * Plus a bounded stability claim (see MONOTONICITY below).
 */
import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import { CONFORMANCE_CASES } from '../../fixtures/markdown/conformanceCases';
import {
  APP_APPLIES_REMEND,
  REMEND_INCOMPLETE_LINK,
  StreamFrame,
  collapse,
  prefixLengths,
  renderScreen,
  renderStreamFrame,
  signatureOf,
} from './renderPipelines';

import remend from 'remend';
import { describe, expect, it } from 'vitest';

/** Frames per case. Enough to cross every delimiter; cheap enough to run always. */
const MAX_FRAMES = 14;

const replay = (input: string): StreamFrame[] =>
  prefixLengths(input, MAX_FRAMES).map((length) => {
    const prefix = input.slice(0, length);
    return renderStreamFrame(prefix, normalizeMathDelimiters(prefix));
  });

/**
 * How many times the content already on screen may legitimately change as more
 * text arrives.
 *
 * A `$$…$$` region gets ONE: it is literal text until the closing `$$` lands,
 * then flips to typeset glyphs. A `\[…\]` or `\(…\)` region gets TWO, and the
 * second one is a measured fact rather than a courtesy: while the region is
 * open, markdown eats the delimiter's backslash and shows a bare `(`, so the
 * text changes once when the opener is consumed and again when the closer
 * arrives and normalization converts the region. A ```` ```math ```` fence gets one.
 */
const churnBudget = (input: string): number => {
  const doubleDollars = (input.match(/(?<!\\)\$\$/g) ?? []).length;
  const brackets = (input.match(/\\\[/g) ?? []).length;
  const parens = (input.match(/\\\(/g) ?? []).length;
  const fences = (input.match(/```(?:math|latex|tex)/g) ?? []).length;
  return Math.ceil(doubleDollars / 2) + brackets * 2 + parens * 2 + fences;
};

/**
 * Markdown whose STRUCTURE changes as it arrives, independently of math: a
 * table is a paragraph until its delimiter row lands, a list item is a
 * paragraph until the next one lands, a fence is prose until it closes — and
 * remend auto-closes a dangling `**`, so the text renders bold, then unbolds
 * when the real closer arrives. That churn is a markdown fact, not a math
 * defect, so the bound below is not applied to these inputs.
 */
const BLOCK_STRUCTURE_RE =
  /^[ \t]*(\||[-*+][ \t]|\d+[.)][ \t]|>|#{1,6}[ \t]|```|~~~| {4}\S)/m;
const INLINE_STRUCTURE_RE = /\*\*|__|`|\]\(|(?<![\\\w])_\S/;

const hasReflowingStructure = (input: string): boolean =>
  BLOCK_STRUCTURE_RE.test(input) || INLINE_STRUCTURE_RE.test(input);

const streamable = CONFORMANCE_CASES.filter((c) => !c.skipStreaming);

describe('streaming replay — no remend artifacts reach the reader', () => {
  for (const testCase of streamable) {
    it(`${testCase.id} — ${testCase.label}`, () => {
      for (const frame of replay(testCase.input)) {
        expect(
          frame.visibleText.includes(REMEND_INCOMPLETE_LINK),
          [
            `case: ${testCase.id}`,
            `prefix: ${JSON.stringify(frame.prefix)}`,
            `normalized: ${JSON.stringify(frame.normalized)}`,
            `text: ${JSON.stringify(frame.visibleText)}`,
            'remend reads a dangling `\\[` as an incomplete link and closes it with',
            'this marker, which CommonMark then leaves in the prose because an',
            'ESCAPED bracket never opened a link. The app turns remend off',
            '(MATH_PARSE_INCOMPLETE_MARKDOWN in components/Markdown/mathRehype.ts);',
            'this frame says that CONSTANT is back on. Whether each renderer',
            'still FORWARDS it to <Streamdown> is asserted separately, in',
            '__tests__/components/Markdown/IncompleteMarkdownWiring.test.tsx.',
          ].join('\n'),
        ).toBe(false);
      }
    });
  }
});

/**
 * Why the family above is not vacuous.
 *
 * It passes because `MATH_PARSE_INCOMPLETE_MARKDOWN` is `false`, so pinning the
 * behaviour that setting exists to avoid is the only thing that keeps the
 * assertion honest: if remend were ever re-enabled, THIS is what every reader
 * would see mid-answer, and the family above would go red for eight cases.
 */
describe('remend — the behaviour MATH_PARSE_INCOMPLETE_MARKDOWN turns off', () => {
  const dangling = 'The array notation \\[ is introduced later in the guide.';

  it('closes a dangling \\[ with a link marker CommonMark cannot consume', () => {
    expect(remend(dangling)).toContain(REMEND_INCOMPLETE_LINK);
    expect(renderScreen(remend(dangling)).proseText).toContain(
      REMEND_INCOMPLETE_LINK,
    );
  });

  it('is not applied by the app, so that marker never renders', () => {
    expect(APP_APPLIES_REMEND).toBe(false);
    expect(renderScreen(dangling).proseText).not.toContain(
      REMEND_INCOMPLETE_LINK,
    );
  });

  it('also closes a half-arrived $$ region, which is what churned mid-stream', () => {
    // C5: every token of a partial formula re-rendered as a KaTeX error span.
    const partial = 'Area:\n\n$$\\frac{\\te';
    expect(remend(partial)).toBe('Area:\n\n$$\\frac{\\te$$');
    expect(renderScreen(remend(partial)).katexErrors).not.toEqual([]);
    expect(renderScreen(partial).katexErrors).toEqual([]);
  });
});

describe('streaming replay — a settled frame renders cleanly', () => {
  for (const testCase of streamable) {
    const run = (): void => {
      for (const frame of replay(testCase.input)) {
        if (!frame.settled) continue;
        const context = [
          `case: ${testCase.id}`,
          `prefix: ${JSON.stringify(frame.prefix)}`,
          `normalized: ${JSON.stringify(frame.normalized)}`,
          `blocks: ${JSON.stringify(frame.blocks)}`,
          `errors: ${JSON.stringify(frame.katexErrors)}`,
          `tex: ${JSON.stringify(frame.texAnnotations)}`,
          'remend changed nothing, so this frame is COMPLETE markdown — it must',
          'not show an error or an empty equation box.',
        ].join('\n');

        if (!testCase.allowKatexError) {
          expect(frame.katexErrors, context).toEqual([]);
        }
        expect(
          frame.texAnnotations.filter((tex) => tex.trim() === ''),
          context,
        ).toEqual([]);
      }
    };

    if (testCase.knownGapFamilies?.includes('streaming')) {
      it.fails(`[known gap] ${testCase.id} — ${testCase.label}`, run);
    } else {
      it(`${testCase.id} — ${testCase.label}`, run);
    }
  }
});

describe('streaming replay — the final frame equals the static render', () => {
  // `mode="streaming"` splits into blocks and remends each; `mode="static"`
  // parses the whole string once. A finished message must be the same either
  // way, or a message changes appearance the moment streaming stops.
  for (const testCase of streamable) {
    const run = (): void => {
      const frames = replay(testCase.input);
      const last = frames[frames.length - 1];
      const staticRender = signatureOf(
        renderScreen(normalizeMathDelimiters(testCase.input)),
      );
      expect(
        last.signature,
        [
          `case: ${testCase.id}`,
          `final streaming frame: ${JSON.stringify(last.signature)}`,
          `static render        : ${JSON.stringify(staticRender)}`,
        ].join('\n'),
      ).toEqual(staticRender);
    };

    if (testCase.knownGapFamilies?.includes('streaming')) {
      it.fails(`[known gap] ${testCase.id} — ${testCase.label}`, run);
    } else {
      it(`${testCase.id} — ${testCase.label}`, run);
    }
  }
});

describe('streaming replay — settled content does not churn', () => {
  // MONOTONICITY. Over the frames that are complete markdown, the text on
  // screen should only ever GROW: what a reader has already read must still be
  // there, in the same order, one chunk later. The one licensed exception is a
  // math region flipping from literal characters to typeset glyphs, which is
  // why the bound is the number of math regions rather than zero.
  for (const testCase of streamable) {
    if (hasReflowingStructure(testCase.input)) continue;

    it(`${testCase.id} — ${testCase.label}`, () => {
      const settled = replay(testCase.input).filter((frame) => frame.settled);
      const unstable: string[] = [];
      for (let i = 1; i < settled.length; i += 1) {
        const before = collapse(settled[i - 1].visibleText);
        const after = collapse(settled[i].visibleText);
        if (!after.startsWith(before)) {
          unstable.push(
            `after ${JSON.stringify(settled[i - 1].prefix)}\n` +
              `  was: ${JSON.stringify(before)}\n` +
              `  now: ${JSON.stringify(after)}`,
          );
        }
      }
      const budget = churnBudget(testCase.input);
      expect(
        unstable.length,
        [
          `case: ${testCase.id}`,
          `budget: ${budget} (one retroactive change allowed per math region)`,
          ...unstable,
        ].join('\n'),
      ).toBeLessThanOrEqual(budget);
    });
  }
});
