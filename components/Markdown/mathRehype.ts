// components/Markdown/mathRehype.ts
import type { Element, Nodes, Root } from 'hast';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import { defaultRehypePlugins } from 'streamdown';
import type { PluggableList, Plugin } from 'unified';

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
 * Attributes KaTeX puts on a `<span>`. `className` carries the entire KaTeX
 * stylesheet contract (`katex`, `katex-display`, `katex-mathml`, `katex-html`,
 * `strut`, `vlist-*`, …) and `style` carries the per-glyph struts and offsets
 * that make a formula lay out at all — without both, a rendered equation
 * collapses into a run of unstyled spans. `ariaHidden` is what keeps screen
 * readers from reading the visual half on top of the MathML half.
 *
 * Scoped to `span` deliberately. Measured: KaTeX emits `class`/`style` on NO
 * other tag, so granting them on `*` would buy nothing for mathematics while
 * letting model- or document-authored raw HTML through with them — a
 * `<div style="position:fixed;inset:0;…">` in a poisoned RAG source or an
 * injected answer would then cover the whole viewport.
 *
 * The per-tag scope alone is not enough, though: a raw `<span>` in a message
 * is still a span, and `display:block;position:fixed;inset:0` (or the
 * Tailwind classes `block fixed inset-0`, which this app's stylesheet really
 * ships) turns one into the same overlay. That is why
 * {@link rehypeStripAuthorPresentation} runs BEFORE KaTeX: by the time the
 * sanitizer sees a span with `style` or `class`, KaTeX is the only thing that
 * can have put them there.
 */
const KATEX_SPAN_ATTRIBUTES = ['className', 'style', 'ariaHidden'] as const;

/**
 * Tags whose `class` the sanitize schema below grants for KaTeX's sake, and
 * which author-controlled HTML must therefore be stripped of first.
 * `code` keeps its `language-*` class: remark-rehype emits it for fences and
 * the default schema value-lists it on its own.
 */
const PRESENTATION_CLASS_TAGS = new Set(['span', 'svg', 'path']);

/**
 * Removes `style` from every element and `class` from the tags above, on the
 * tree AS IT STANDS BEFORE `rehype-katex` RUNS.
 *
 * Streamdown's chain is raw → katex → sanitize → harden. `rehype-raw` has
 * already turned any raw HTML in the message — the model's, a RAG source's,
 * a pasted document's — into elements by this point, and KaTeX has not yet
 * added its own. So what this pass removes is exactly the author-controlled
 * presentation, and what it leaves for the sanitizer to keep is exactly the
 * KaTeX-generated presentation. No ancestry or class-name heuristic is
 * involved (a raw `<span class="katex">` would defeat one), which is what
 * makes it a boundary rather than a filter.
 *
 * Nothing the default schema would have kept is lost: it grants `style`
 * nowhere and `class` only on `code`, so before the KaTeX widening every
 * attribute removed here was being removed by the sanitizer anyway.
 */
export const rehypeStripAuthorPresentation: Plugin<[], Root> = () => (tree) => {
  const strip = (node: Nodes): void => {
    if (node.type === 'element') {
      const element = node as Element;
      if (element.properties) {
        delete element.properties.style;
        if (PRESENTATION_CLASS_TAGS.has(element.tagName)) {
          delete element.properties.className;
        }
      }
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) strip(child as Nodes);
    }
  };
  strip(tree);
};

/**
 * MathML presentation attributes KaTeX emits, granted only on the MathML tags
 * above (never on `*` — see {@link KATEX_SPAN_ATTRIBUTES}).
 */
const MATHML_ATTRIBUTES = [
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
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    ...MATHML_TAG_NAMES,
    // Stretchy delimiters, arrows and braces (\left(, \xrightarrow,
    // \overbrace) are drawn as inline SVG paths rather than glyphs.
    'svg',
    'path',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // NOTE: no '*' entry. Everything below is granted per tag so that raw
    // HTML in a message cannot inherit `style`/`class` from the math surface.
    span: [...(defaultSchema.attributes?.span ?? []), ...KATEX_SPAN_ATTRIBUTES],
    ...Object.fromEntries(
      MATHML_TAG_NAMES.map((tag) => [
        tag,
        [...(defaultSchema.attributes?.[tag] ?? []), ...MATHML_ATTRIBUTES],
      ]),
    ),
    svg: [
      'className',
      'style',
      'width',
      'height',
      'viewBox',
      'preserveAspectRatio',
      'xmlns',
    ],
    path: ['d'],
  },
};

/**
 * Streamdown's default rehype chain with its `sanitize` step re-armed and
 * {@link rehypeStripAuthorPresentation} inserted ahead of `katex`.
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
 * left untouched, so the only widening is the KaTeX surface above, granted per
 * tag rather than on `*` — and, because author-controlled `style`/`class` are
 * stripped before KaTeX runs, model-authored raw HTML gains nothing from it
 * on any tag, `<span>` included. `rehype-harden` still runs after.
 */
export const MATH_REHYPE_PLUGINS: PluggableList = Object.entries(
  defaultRehypePlugins,
).flatMap(([name, plugin]): PluggableList => {
  if (name === 'katex') return [rehypeStripAuthorPresentation, plugin];
  if (name === 'sanitize') return [[rehypeSanitize, MATH_SANITIZE_SCHEMA]];
  return [plugin];
});

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
