import {
  PROMPT_TEXT_DELIMITER,
  createDelimiterEchoFilter,
  stripEchoedDelimiters,
} from '@/lib/utils/shared/translation/delimiterEcho';

import { describe, expect, it } from 'vitest';

const FENCE = PROMPT_TEXT_DELIMITER;
const SOURCE = 'Give 1 tab once daily.';
const TRANSLATION = 'Dar 1 comprimido una vez al día.\n\nTratar pronto.';

/** Feeds the output to a filter in pieces of `size` characters. */
function streamed(output: string, size: number, source = SOURCE) {
  const filter = createDelimiterEchoFilter(source);
  const shown: string[] = [];
  for (let index = 0; index < output.length; index += size) {
    shown.push(filter.push(output.slice(index, index + size)));
  }
  const beforeEnd = shown.join('');
  return { beforeEnd, all: beforeEnd + filter.end() };
}

describe('stripEchoedDelimiters', () => {
  it('removes a fence echoed around the output', () => {
    expect(
      stripEchoedDelimiters(`${FENCE}\n${TRANSLATION}\n${FENCE}`, SOURCE),
    ).toBe(TRANSLATION);
  });

  it('removes a fence echoed at one end only', () => {
    expect(stripEchoedDelimiters(`${FENCE}\n${TRANSLATION}`, SOURCE)).toBe(
      TRANSLATION,
    );
    expect(stripEchoedDelimiters(`${TRANSLATION}\n${FENCE}\n`, SOURCE)).toBe(
      TRANSLATION,
    );
  });

  it('leaves output without a fence alone, apart from trimming', () => {
    expect(stripEchoedDelimiters(`\n${TRANSLATION}\n`, SOURCE)).toBe(
      TRANSLATION,
    );
  });

  it('keeps ordinary quotation marks at the ends', () => {
    const quoted = '"Hola", dijo. Respondió: "adiós"';
    expect(stripEchoedDelimiters(quoted, SOURCE)).toBe(quoted);
    // Two quotes are not a fence.
    expect(stripEchoedDelimiters('""Hola""', SOURCE)).toBe('""Hola""');
  });

  it('keeps a fence that the source itself starts or ends with', () => {
    const docstring = `${FENCE}Return the dose.${FENCE}`;
    const translated = `${FENCE}Devuelve la dosis.${FENCE}`;
    expect(stripEchoedDelimiters(translated, docstring)).toBe(translated);
    // Decided per end: a source fenced only at the start loses a trailing echo.
    expect(stripEchoedDelimiters(translated, `${FENCE}Return the dose.`)).toBe(
      `${FENCE}Devuelve la dosis.`,
    );
  });

  it('returns an empty string for output that is only fences', () => {
    expect(stripEchoedDelimiters(`${FENCE}\n${FENCE}`, SOURCE)).toBe('');
  });
});

describe('createDelimiterEchoFilter', () => {
  const fenced = `${FENCE}\n${TRANSLATION}\n${FENCE}`;

  it.each([1, 2, 3, 4, 7, 1000])(
    'never shows an echoed fence, whatever the piece size (%i)',
    (size) => {
      const { beforeEnd, all } = streamed(fenced, size);
      expect(beforeEnd).not.toContain(FENCE);
      expect(all).toBe(TRANSLATION);
    },
  );

  it.each([1, 3, 1000])(
    'matches stripEchoedDelimiters for unfenced output (piece size %i)',
    (size) => {
      const output = `\n\n${TRANSLATION}\n`;
      expect(streamed(output, size).all).toBe(
        stripEchoedDelimiters(output, SOURCE),
      );
    },
  );

  it('passes text through as it arrives, withholding only a possible fence', () => {
    const filter = createDelimiterEchoFilter(SOURCE);
    expect(filter.push('Dar 1 ')).toBe('Dar 1');
    expect(filter.push('comprimido')).toBe(' comprimido');
    expect(filter.push('.\n"')).toBe('.');
    expect(filter.end()).toBe('\n"');
  });

  it('keeps quotation marks inside and at the ends of real text', () => {
    const quoted = '"Hola", dijo "ella". Respondió: "adiós"';
    expect(streamed(quoted, 1).all).toBe(quoted);
  });

  it('keeps a fence that belongs to the source', () => {
    const docstring = `${FENCE}Return the dose.${FENCE}`;
    const translated = `${FENCE}Devuelve la dosis.${FENCE}`;
    expect(streamed(translated, 2, docstring).all).toBe(translated);
  });

  it('shows nothing for output that is only fences or empty', () => {
    expect(streamed(`${FENCE}\n${FENCE}`, 1).all).toBe('');
    expect(streamed('', 1).all).toBe('');
  });
});
