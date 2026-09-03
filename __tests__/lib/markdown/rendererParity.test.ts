/**
 * FAMILY 4 — RENDERER PARITY.
 *
 * The same message is rendered by three different engines that share no code:
 *
 *   screen  Streamdown → remark-math → KaTeX (typeset equations)
 *   export  `markdownToHtml` → `marked` + a math extension (TeX as text) —
 *           the choke point for .docx, .pdf, .html, .txt and the document editor
 *   .md     the ONE surface that bypasses that choke point:
 *           `MessageDownloadMenu.prepare` short-circuits `markdownToHtml` for
 *           `format === 'md'` and writes the markdown to disk, so the file's
 *           math correctness rests on that component's own
 *           `normalizeMathDelimiters` call (and `ShareToOneDriveModal`'s)
 *   TTS     `toSpeakableText` → `cleanMarkdown` → the speech synthesizer
 *
 * They cannot all do the same thing: Word has no KaTeX and a voice cannot say
 * `\frac`. The requirement is not sameness, it is that every difference is
 * DECLARED and asserted. A renderer that quietly stops honouring its promise —
 * an equation arriving in Word as `$$<br>\frac{a}{b}<br>$$`, a voice reading
 * "backslash frac" — is the failure mode this family exists to catch, and it is
 * exactly what issue #121's C6 was.
 *
 * `RENDERER_PARITY_MATRIX` is the promise, one row per feature; the tests below
 * turn each cell into an assertion. The export column encodes what
 * `markdownToHtml`'s own JSDoc promises: "for any math region, the exported
 * document's plain text equals that region of the normalized markdown character
 * for character".
 */
import { cleanMarkdown } from '@/lib/utils/app/clean';
import { markdownToHtml } from '@/lib/utils/shared/document/formatConverter';
import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';
import { toSpeakableText } from '@/lib/utils/shared/markdown/speakableText';

import {
  CONFORMANCE_CASES,
  ConformanceCase,
  RENDERER_PARITY_MATRIX,
} from '../../fixtures/markdown/conformanceCases';
import {
  LEAK_TOKENS,
  TEX_COMMAND_TOKENS,
  collapse,
  renderScreen,
} from './renderPipelines';

import { decode } from 'he';
import { describe, expect, it } from 'vitest';

/** The reader's view of an exported document: tags gone, entities decoded. */
const exportedText = (markdown: string): string =>
  decode(
    markdownToHtml(markdown)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );

/**
 * The reader's view of a downloaded `.md` file.
 *
 * NOT `exportedText`: `markdownToHtml` normalizes internally (formatConverter
 * line ~265), which makes that helper normalization-immune and therefore blind
 * to this surface. The md branch never calls it, so the bytes on disk are just
 * the normalized markdown — and if the call sites stop normalizing, a user
 * downloading .md and .docx from the same menu on the same message gets `\[ …
 * \]` in one and `$$ … $$` in the other.
 */
const mdFileText = (markdown: string): string =>
  normalizeMathDelimiters(markdown);

/**
 * The real TTS chain: the client strips math to a spoken placeholder, then the
 * server's `cleanMarkdown` strips the remaining markdown chrome. Order matters —
 * `cleanMarkdown`'s emphasis rule eats the underscores in `x_1` and would
 * shred the TeX if it ran first.
 */
const spokenText = (markdown: string): string =>
  cleanMarkdown(toSpeakableText(markdown));

const byId = new Map(CONFORMANCE_CASES.map((c) => [c.id, c]));

const requireCase = (id: string): ConformanceCase => {
  const found = byId.get(id);
  if (!found) throw new Error(`parity matrix references unknown case "${id}"`);
  return found;
};

describe('parity matrix hygiene', () => {
  it('every row points at a real corpus case', () => {
    for (const row of RENDERER_PARITY_MATRIX) {
      expect(byId.has(row.caseId), `unknown caseId ${row.caseId}`).toBe(true);
    }
  });

  it('every declared downgrade says what the downgrade IS', () => {
    // A downgrade with no note is an undocumented divergence wearing a label.
    for (const row of RENDERER_PARITY_MATRIX) {
      if (row.export === 'declared-downgrade') {
        expect(row.exportNote.trim().length, row.feature).toBeGreaterThan(10);
      }
      if (row.tts === 'declared-downgrade') {
        expect(row.ttsNote.trim().length, row.feature).toBeGreaterThan(10);
      }
    }
  });
});

describe('parity — screen column', () => {
  for (const row of RENDERER_PARITY_MATRIX) {
    it(`${row.feature} (${row.caseId})`, () => {
      const testCase = requireCase(row.caseId);
      const analysis = renderScreen(normalizeMathDelimiters(testCase.input));
      const context = `${row.feature}\ninput:\n${testCase.input}\nhtml:\n${analysis.html.slice(0, 800)}`;

      expect(
        row.screen,
        `${row.feature}: the screen never downgrades math`,
      ).toBe('supported');
      if (testCase.expectation === 'renders-math') {
        expect(analysis.katexCount, context).toBeGreaterThan(0);
      } else {
        expect(analysis.katexCount, context).toBe(0);
      }
      for (const needle of testCase.mustContainText ?? []) {
        expect(analysis.visibleText, context).toContain(needle);
      }
    });
  }
});

describe('parity — export column', () => {
  for (const row of RENDERER_PARITY_MATRIX) {
    it(`${row.feature} (${row.caseId})`, () => {
      const testCase = requireCase(row.caseId);
      const normalized = normalizeMathDelimiters(testCase.input);
      const screen = renderScreen(normalized);
      const exported = exportedText(testCase.input);
      const context = [
        `feature: ${row.feature}`,
        `declared: export = ${row.export} — ${row.exportNote}`,
        `input:\n${testCase.input}`,
        `normalized:\n${normalized}`,
        `exported text:\n${exported}`,
      ].join('\n');

      // Whatever the column says, prose must not be lost in the export.
      for (const needle of testCase.mustContainText ?? []) {
        expect(exported, context).toContain(needle);
      }

      if (row.export === 'declared-downgrade') {
        // The declared downgrade, asserted literally: every expression the
        // screen typeset must be recoverable from the exported document, TeX
        // and delimiters intact. This is what fails if `marked` ever eats a
        // backslash or `breaks: true` sprays <br> through a multi-line block.
        expect(
          screen.texAnnotations.length,
          `${context}\n(a downgrade row whose case renders no math proves nothing)`,
        ).toBeGreaterThan(0);
        for (const tex of screen.texAnnotations) {
          expect(exported, context).toContain(tex.trim());
        }
        expect(exported, context).toContain('$$');
      }

      // Delimiters the export cannot represent must never reach it: marked
      // consumes `\[` and `\(` as markdown escapes, and once consumed the
      // math is unrecoverable in Word, Obsidian or anywhere else.
      expect(exported, context).not.toContain('\\[');
      expect(exported, context).not.toContain('\\(');

      // Same promise for the .md file, which reaches disk without ever
      // touching markdownToHtml.
      const mdFile = mdFileText(testCase.input);
      expect(mdFile, `${context}\nmd file:\n${mdFile}`).not.toContain('\\[');
      expect(mdFile, `${context}\nmd file:\n${mdFile}`).not.toContain('\\(');
      if (row.export === 'declared-downgrade') {
        for (const tex of screen.texAnnotations) {
          expect(collapse(mdFile), `${context}\nmd file:\n${mdFile}`).toContain(
            collapse(tex),
          );
        }
        expect(mdFile, `${context}\nmd file:\n${mdFile}`).toContain('$$');
      }
    });
  }
});

describe('parity — TTS column', () => {
  for (const row of RENDERER_PARITY_MATRIX) {
    it(`${row.feature} (${row.caseId})`, () => {
      const testCase = requireCase(row.caseId);
      const spoken = spokenText(testCase.input);
      const context = [
        `feature: ${row.feature}`,
        `declared: tts = ${row.tts} — ${row.ttsNote}`,
        `input:\n${testCase.input}`,
        `spoken:\n${spoken}`,
      ].join('\n');

      // A voice reading "backslash frac open brace" is worse than silence.
      for (const token of LEAK_TOKENS) {
        expect(spoken.includes(token), `${context}\nleaked: ${token}`).toBe(
          false,
        );
      }
      expect(spoken, context).not.toContain('$$');

      for (const needle of testCase.mustContainText ?? []) {
        expect(spoken, context).toContain(needle);
      }

      if (row.ttsSpoken) {
        // The declared downgrade made concrete: either the verbalization or
        // the placeholder, never silence and never TeX.
        expect(spoken, context).toContain(row.ttsSpoken);
      }
    });
  }
});

describe('parity sweep — no silent divergence anywhere in the corpus', () => {
  // The matrix is the curated promise; this is the exhaustive check behind it.
  // Every case that typesets on screen must be recoverable in the export, and
  // no case may hand raw TeX to a speech synthesizer. A new corpus case is
  // covered here the moment it is added, with no matrix row required.
  for (const testCase of CONFORMANCE_CASES) {
    const run = (): void => {
      const normalized = normalizeMathDelimiters(testCase.input);
      const screen = renderScreen(normalized);
      const exported = exportedText(testCase.input);

      const mdFile = mdFileText(testCase.input);

      for (const tex of screen.texAnnotations) {
        if (tex.trim() === '') continue;
        expect(
          collapse(exported),
          [
            `case: ${testCase.id}`,
            'the screen typeset this expression but the export lost it:',
            tex,
            `normalized:\n${normalized}`,
            `exported:\n${exported}`,
          ].join('\n'),
        ).toContain(collapse(tex));
        // The .md surface bypasses markdownToHtml entirely, so it needs its
        // own sweep or the divergence can come back there unseen.
        expect(
          collapse(mdFile),
          [
            `case: ${testCase.id}`,
            'the screen typeset this expression but the .md download lost it:',
            tex,
            `md file:\n${mdFile}`,
          ].join('\n'),
        ).toContain(collapse(tex));
      }

      // A ```latex fence is TeX the reader asked to SEE, and this app reads
      // code aloud as words; whether it should is a separate product decision.
      if (!testCase.rawTexIsIntentional) {
        const spoken = spokenText(testCase.input);
        const leaked = TEX_COMMAND_TOKENS.filter((token) =>
          spoken.includes(token),
        );
        expect(
          leaked,
          [
            `case: ${testCase.id}`,
            'a TeX command reached the speech synthesizer, which reads it out',
            'verbatim ("backslash frac open brace a close brace").',
            `spoken:\n${spoken}`,
          ].join('\n'),
        ).toEqual([]);
      }
    };

    if (testCase.knownGapFamilies?.includes('parity')) {
      it.fails(`[known gap] ${testCase.id} — ${testCase.label}`, run);
    } else {
      it(`${testCase.id} — ${testCase.label}`, run);
    }
  }
});
