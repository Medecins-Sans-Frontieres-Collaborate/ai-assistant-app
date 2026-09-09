import { toSpeakableText } from '@/lib/utils/shared/markdown/speakableText';

import { describe, expect, it } from 'vitest';

const raw = String.raw;
const lines = (...parts: string[]) => parts.join('\n');

describe('toSpeakableText', () => {
  describe('simple expressions are read out, not spelled out', () => {
    it('says a power instead of a caret', () => {
      expect(toSpeakableText('So $$E = mc^2$$ follows.')).toBe(
        'So E equals mc squared follows.',
      );
    });

    it('says a fraction as "over"', () => {
      expect(toSpeakableText(raw`The ratio $$\frac{a}{b}$$ matters.`)).toBe(
        'The ratio a over b matters.',
      );
    });

    it('reads Greek letters and operators by name', () => {
      expect(toSpeakableText(raw`$$\alpha \times \pi$$`)).toBe(
        'alpha times pi',
      );
    });

    it('reads a comparison and a subscript', () => {
      expect(toSpeakableText(raw`$$x_1 \le y_2$$`)).toBe(
        'x sub 1 less than or equal to y sub 2',
      );
    });

    it('reads \\text{} contents as the prose they are', () => {
      expect(toSpeakableText(raw`$$\text{Total} = 12$$`)).toBe(
        'Total equals 12',
      );
    });

    it('handles the \\( \\) and \\[ \\] delimiters models emit unprompted', () => {
      expect(toSpeakableText(raw`Area \( A = \pi r^2 \) grows.`)).toBe(
        'Area A equals pi r squared grows.',
      );
      expect(toSpeakableText(raw`Answer: \[ \sqrt{x} \]`)).toBe(
        'Answer: square root of x',
      );
    });
  });

  describe('never reads LaTeX syntax aloud', () => {
    // The whole point of the helper: the synthesizer used to say
    // "backslash frac open brace a close brace over..." (issue #121).
    const NEVER_SPOKEN = ['\\', '{', '}', '^', '_', '$'];

    it.each([
      [
        'aligned derivation',
        lines(
          '$$',
          raw`\begin{aligned}`,
          raw`a &= b \\`,
          'c &= d',
          raw`\end{aligned}`,
          '$$',
        ),
      ],
      ['matrix', raw`$$\begin{pmatrix} 1 & 0 \\ 0 & 1 \end{pmatrix}$$`],
      ['unknown command', raw`$$\widehat{\mathfrak{X}}_{\aleph}$$`],
      ['very long expression', `$$${'x + '.repeat(60)}y$$`],
    ])('collapses %s to the placeholder', (_label, input) => {
      const spoken = toSpeakableText(input);
      expect(spoken).toContain('equation');
      for (const char of NEVER_SPOKEN) {
        expect(spoken).not.toContain(char);
      }
    });

    it('accepts a localized placeholder from the call site', () => {
      expect(
        toSpeakableText(raw`$$\begin{aligned} a &= b \end{aligned}$$`, {
          equationPlaceholder: 'une équation',
        }),
      ).toBe('une équation');
    });
  });

  describe('leaves alone what is not math', () => {
    it('does not touch currency, which is not math in this app', () => {
      const text = 'Budget is $5,000 for supplies and $12,000 for staff.';
      expect(toSpeakableText(text)).toBe(text);
    });

    it('does not touch a lone dollar amount', () => {
      expect(toSpeakableText('It costs $5 per kit.')).toBe(
        'It costs $5 per kit.',
      );
    });

    it('does not touch a shell variable in an inline code span', () => {
      const text = 'Run `echo $HOME` first.';
      expect(toSpeakableText(text)).toBe(text);
    });

    it('does not touch math-looking text inside a fenced code block', () => {
      const text = lines('```sh', 'echo $$x^2$$', '```');
      expect(toSpeakableText(text)).toBe(text);
    });

    it('returns messages with no math completely unchanged', () => {
      const text = '# Report\n\nWe distributed **12,000** kits.';
      expect(toSpeakableText(text)).toBe(text);
    });

    it('leaves the surrounding markdown chrome for cleanMarkdown to strip', () => {
      // Deliberate division of labour: duplicating the server-side stripper
      // here would give the app two of them, drifting apart.
      expect(toSpeakableText('## Result\n\n**Bold** and $$x^2$$.')).toBe(
        '## Result\n\n**Bold** and x squared.',
      );
    });
  });

  describe('spacing', () => {
    it('never fuses a formula onto the neighbouring word', () => {
      expect(toSpeakableText('is$$x$$here')).toBe('is x here');
    });

    it('keeps paragraph breaks, which the synthesizer reads as pauses', () => {
      expect(toSpeakableText('One $$x$$\n\nTwo')).toBe('One x\n\nTwo');
    });
  });
});
