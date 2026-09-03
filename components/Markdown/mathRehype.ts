// components/Markdown/mathRehype.ts
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import { defaultRehypePlugins } from 'streamdown';
import type { PluggableList } from 'unified';

/**
 * MathML element names KaTeX emits inside `<span class="katex-mathml">`.
 * `hast-util-sanitize`'s default schema is an HTML-only allow-list, so every
 * one of these is otherwise unwrapped to its bare text content.
 */
const MATHML_TAG_NAMES = [
  'math',
  'semantics',
  'annotation',
  'annotation-xml',
  'maction',
  'menclose',
  'merror',
  'mfrac',
  'mi',
  'mlabeledtr',
  'mmultiscripts',
  'mn',
  'mo',
  'mover',
  'mpadded',
  'mphantom',
  'mprescripts',
  'mroot',
  'mrow',
  'ms',
  'mspace',
  'msqrt',
  'mstyle',
  'msub',
  'msubsup',
  'msup',
  'mtable',
  'mtd',
  'mtext',
  'mtr',
  'munder',
  'munderover',
  'none',
] as const;

/**
 * Attributes KaTeX puts on its output. `className` carries the entire KaTeX
 * stylesheet contract (`katex`, `katex-display`, `katex-mathml`, `katex-html`,
 * `strut`, `vlist-*`, …) and `style` carries the per-glyph struts and offsets
 * that make a formula lay out at all — without both, a rendered equation
 * collapses into a run of unstyled spans. `ariaHidden` is what keeps screen
 * readers from reading the visual half on top of the MathML half.
 */
const MATH_ATTRIBUTES = [
  'className',
  'style',
  'ariaHidden',
  // MathML presentation attributes.
  'accent',
  'accentunder',
  'close',
  'columnalign',
  'columnlines',
  'columnspacing',
  'depth',
  'display',
  'displaystyle',
  'encoding',
  'fence',
  'form',
  'height',
  'largeop',
  'linethickness',
  'lspace',
  'mathvariant',
  'maxsize',
  'minsize',
  'movablelimits',
  'notation',
  'open',
  'rowlines',
  'rowspacing',
  'rspace',
  'scriptlevel',
  'separator',
  'separators',
  'stretchy',
  'symmetric',
  'voffset',
  'width',
  'xmlns',
] as const;

/**
 * `hast-util-sanitize` falls back to the default schema for any top-level key
 * the caller omits, so Streamdown's `{}` IS the GitHub-style default schema.
 * This widens exactly two of its keys and nothing else.
 */
export const MATH_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...MATHML_TAG_NAMES],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), ...MATH_ATTRIBUTES],
  },
};

/**
 * Streamdown's default rehype chain with ONLY its `sanitize` step re-armed.
 *
 * Streamdown runs `rehype-sanitize` AFTER `rehype-katex`, with a schema that
 * allows neither MathML nor `class`/`style`. The measured effect is that every
 * equation reaches the DOM as bare unstyled spans reading
 * `ab\frac{a}{b}ab` — the MathML text, then the `<annotation>` TeX source,
 * then the visual layer's text, concatenated (this is the exact string users
 * report seeing, and it is also what selection-copy yields). No amount of
 * delimiter normalization or CSS can fix that; the classes never survive.
 *
 * `rehype-raw` and `rehype-harden` (link/image/protocol allow-listing) are
 * left untouched, so the only widening is the KaTeX surface above. Note this
 * does admit `style` on model-authored spans; that is the deliberate trade for
 * having renderable mathematics at all, and `rehype-harden` still runs after.
 */
export const MATH_REHYPE_PLUGINS: PluggableList = Object.entries(
  defaultRehypePlugins,
).map(([name, plugin]) =>
  name === 'sanitize' ? [rehypeSanitize, MATH_SANITIZE_SCHEMA] : plugin,
);
