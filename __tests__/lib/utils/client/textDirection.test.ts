// @vitest-environment jsdom
// Reads computed styles, so it needs a DOM although it lives with the
// server-side utility tests.
import {
  inlineEndSign,
  isRtlElement,
  mirrorSide,
} from '@/lib/utils/client/textDirection';

import { afterEach, describe, expect, it } from 'vitest';

describe('textDirection', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('dir');
    document.body.innerHTML = '';
  });

  const elementWithDirection = (direction: 'rtl' | 'ltr'): HTMLElement => {
    const element = document.createElement('div');
    element.style.direction = direction;
    document.body.appendChild(element);
    return element;
  };

  it('reports right-to-left only for right-to-left elements', () => {
    expect(isRtlElement(elementWithDirection('rtl'))).toBe(true);
    expect(isRtlElement(elementWithDirection('ltr'))).toBe(false);
  });

  it('falls back to the document root when no element is given', () => {
    expect(isRtlElement()).toBe(false);
    document.documentElement.style.direction = 'rtl';
    expect(isRtlElement(null)).toBe(true);
    document.documentElement.style.direction = '';
  });

  it('flips the sign of rightward movement in right-to-left layouts', () => {
    expect(inlineEndSign(elementWithDirection('ltr'))).toBe(1);
    expect(inlineEndSign(elementWithDirection('rtl'))).toBe(-1);
  });

  it('mirrors a physical side only in right-to-left layouts', () => {
    expect(mirrorSide('left', false)).toBe('left');
    expect(mirrorSide('right', false)).toBe('right');
    expect(mirrorSide('left', true)).toBe('right');
    expect(mirrorSide('right', true)).toBe('left');
  });
});
