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

/**
 * Whether Streamdown may run `remend` over a partial block while a message
 * streams (Streamdown's own default is `true`).
 *
 * OFF, because remend is measurably wrong on this app's content:
 *  - it counts brackets without honouring backslash escapes, so a `\[` with no
 *    `\]` yet — the opener of every display equation GPT emits — is read as an
 *    incomplete LINK and closed with `](streamdown:incomplete-link)`. CommonMark
 *    does not open a link on an escaped bracket, so that closer is never
 *    consumed: the literal string is printed into the answer, and for a message
 *    that merely MENTIONS `\[` it stays there for the whole stream.
 *  - it closes a partial `$$` region with another `$$`, so every token of a
 *    half-arrived formula re-renders as a churning red KaTeX error span.
 *
 * What is given up is small by comparison: remend does NOT close incomplete
 * code fences (measured on remend 1.0.1 — `"```python\nprint(1)"` comes back
 * unchanged), so all it buys is auto-closing a half-typed `**bold`, `*em*` or
 * `` `code` ``, which now shows its markers for the few hundred milliseconds
 * before the closer arrives.
 *
 * Exported rather than inlined so the conformance harness
 * (`__tests__/lib/markdown/renderPipelines.ts`) models the real streaming path
 * instead of assuming one.
 */
export const MATH_PARSE_INCOMPLETE_MARKDOWN = false;
