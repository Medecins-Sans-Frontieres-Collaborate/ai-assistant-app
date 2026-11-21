import {
  bulletsToText,
  textToBullets,
} from '@/components/Workflows/DeckBuilder/bulletsText';

import { describe, expect, it } from 'vitest';

describe('bullets as text', () => {
  it('indents two spaces per level, and reads them back', () => {
    const bullets = [
      { text: 'Clinics', level: 0 },
      { text: 'Rural', level: 1 },
      { text: 'Deep', level: 2 },
    ];
    const text = bulletsToText(bullets);
    expect(text).toBe('Clinics\n  Rural\n    Deep');
    expect(textToBullets(text)).toEqual(bullets);
  });

  it('keeps what is typed, so typing never jumps', () => {
    // Every prefix of an indented line reads back to itself.
    const typed = 'One\n  Two';
    for (let end = 1; end <= typed.length; end++) {
      const prefix = typed.slice(0, end);
      expect(bulletsToText(textToBullets(prefix))).toBe(prefix);
    }
    // A lone space is text, not half an indent.
    expect(textToBullets(' x')).toEqual([{ text: ' x', level: 0 }]);
    // An empty line is an empty bullet (the plan check drops it).
    expect(textToBullets('a\n')).toEqual([
      { text: 'a', level: 0 },
      { text: '', level: 0 },
    ]);
  });

  it('takes tabs as levels, and stops at the deepest level', () => {
    expect(textToBullets('\tx')).toEqual([{ text: 'x', level: 1 }]);
    expect(textToBullets(' '.repeat(12) + 'x')).toEqual([
      { text: '    x', level: 4 },
    ]);
  });
});
