import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-text guard for the KaTeX presentation rules in `app/globals.css`.
 *
 * jsdom has no cascade and no layout, so no component test can see that a long
 * equation overflows its bubble or that a mouse selection picked up three
 * overlapping transcriptions of the same formula (issue #121). Reading the
 * stylesheet can — the same technique `__tests__/design/adminSurfaceTokens.test.ts`
 * already uses. Deliberately narrow: three rules and one cascade invariant,
 * not a general CSS linter.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const GLOBALS_CSS = readFileSync(resolve(REPO_ROOT, 'app/globals.css'), 'utf8');
const KATEX_CSS = readFileSync(
  resolve(REPO_ROOT, 'node_modules/katex/dist/katex.min.css'),
  'utf8',
);

/** Property names declared by every rule whose selector list contains `selector`. */
function declaredProperties(css: string, selector: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const properties: string[] = [];
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    for (const declaration of rule[2].split(';')) {
      const name = declaration.split(':')[0].trim().toLowerCase();
      if (name) properties.push(name);
    }
  }
  return properties;
}

describe('KaTeX presentation rules in app/globals.css', () => {
  it('lets a long display equation scroll instead of overflowing the bubble', () => {
    const properties = declaredProperties(GLOBALS_CSS, '.katex-display');
    expect(properties).toContain('overflow-x');
    expect(properties).toContain('max-width');
  });

  it('gives the scroll box room for descenders', () => {
    // KaTeX glyphs (integrals, fractions, subscripts) hang below the declared
    // line box; a bare `overflow: auto` shaves them off. The padding is the
    // affordance, so it is part of the rule, not decoration.
    const properties = declaredProperties(GLOBALS_CSS, '.katex-display');
    expect(properties).toContain('padding-bottom');
    expect(properties).toContain('overflow-y');
  });

  it('keeps the MathML layer out of a mouse selection', () => {
    // Without this, selecting an equation copies the MathML text, the x-tex
    // annotation AND the visual layer, concatenated — the exact garbage pasted
    // into issue #121. `user-select` is pointer-only; assistive tech still
    // reads the MathML.
    expect(declaredProperties(GLOBALS_CSS, '.katex-mathml')).toContain(
      'user-select',
    );
  });

  it('never collides with katex.min.css at equal specificity', () => {
    // `app/layout.tsx` imports katex.min.css a SECOND time, after globals.css.
    // So at equal specificity KaTeX wins, and any override here that touches a
    // property KaTeX also sets on the same selector would silently do nothing.
    for (const selector of ['.katex-display', '.katex-mathml', '.katex']) {
      const ours = new Set(declaredProperties(GLOBALS_CSS, selector));
      const theirs = declaredProperties(KATEX_CSS, selector);
      const collisions = theirs.filter((property) => ours.has(property));
      expect(collisions, `${selector} collides with katex.min.css`).toEqual([]);
    }
  });
});
