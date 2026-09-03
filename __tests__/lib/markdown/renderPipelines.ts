/**
 * Shared rendering machinery for the four markdown conformance families.
 *
 * Not a `.test.ts`, so vitest does not collect it (the node config only
 * matches `__tests__/lib/**\/*.test.ts`).
 *
 * WHY THIS BUILDS THE PIPELINE OUT OF STREAMDOWN'S OWN EXPORTS
 * ------------------------------------------------------------
 * `defaultRemarkPlugins` / `defaultRehypePlugins` are the exact plugin tuples
 * `<Streamdown>` uses, including their OPTIONS. Reconstructing the chain by
 * hand (`.use(remarkMath)`) would silently diverge the day Streamdown changes
 * an option — and one of those options, `singleDollarTextMath: false`, is the
 * single most consequential fact about math in this app. Importing the tuples
 * means this harness tracks the real renderer across upgrades instead of
 * testing a fiction.
 *
 * THE SANITIZER IS PART OF THE PIPELINE, NOT A DETAIL
 * ---------------------------------------------------
 * Streamdown's rehype chain is `{raw, katex, sanitize, harden}` in that order —
 * `rehype-sanitize` runs AFTER `rehype-katex`, and its stock schema allows
 * neither MathML nor `class`/`style`, so a rendered equation reaches the DOM as
 * unstyled spans reading `ab\frac{a}{b}ab`. `renderScreen` therefore uses the
 * app's real `MATH_REHYPE_PLUGINS` (Streamdown's chain with the sanitize step
 * re-armed) rather than stopping at KaTeX: a harness that skipped the sanitizer
 * would have declared issue #121 fixed while the page still showed source.
 *
 * Because that one step can fail every case at once, `renderWithStockSanitize`
 * and `renderWithoutSanitize` exist beside it — `renderConformance.test.ts`
 * uses them to turn "everything is broken" into a one-line diagnosis.
 */
import { MATH_REHYPE_PLUGINS } from '@/components/Markdown/mathRehype';

import type { Element, Nodes, Root } from 'hast';
import { toHtml } from 'hast-util-to-html';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remend from 'remend';
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  parseMarkdownIntoBlocks,
} from 'streamdown';
import type { PluggableList, Processor } from 'unified';
import { unified } from 'unified';

/**
 * Text that must never reach a reader's eyes. If any of these survives into
 * visible prose, the user is looking at LaTeX source instead of an equation —
 * which is the whole of issue #121 in one boolean.
 */
export const LEAK_TOKENS = [
  '\\frac',
  '\\text{',
  '\\begin{',
  '\\end{',
  '\\[',
  '\\(',
] as const;

/**
 * remend's marker for an auto-closed incomplete link. `\[` at the end of a
 * streaming chunk looks like a markdown link opener to remend, so an agent
 * emitting `\[ \frac{a` mid-stream prints this literal string on screen.
 */
export const REMEND_INCOMPLETE_LINK = '](streamdown:incomplete-link)';

type MarkdownProcessor = Processor<
  Root,
  undefined,
  undefined,
  undefined,
  undefined
>;

/** remark side: parse + exactly what Streamdown configures (gfm, math, cjk). */
const remarkChain = (): MarkdownProcessor =>
  unified()
    .use(remarkParse)
    .use(
      Object.values(defaultRemarkPlugins) as PluggableList,
    ) as MarkdownProcessor;

/**
 * The chain the chat surface actually runs: Streamdown's remark plugins, then
 * the app's `MATH_REHYPE_PLUGINS` (raw → katex → KaTeX-aware sanitize →
 * harden). `allowDangerousHtml` + `rehype-raw` mirror Streamdown, so the app's
 * own `<<<SENTINEL>>>` text and any raw HTML travel the road they do live.
 */
const screenProcessor = remarkChain()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(MATH_REHYPE_PLUGINS);

/** Stock Streamdown chain, unmodified. Used only to pin why the override exists. */
const stockProcessor = remarkChain()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(Object.values(defaultRehypePlugins) as PluggableList);

/** Everything up to KaTeX and no further — isolates "is the MATH right?". */
const noSanitizeProcessor = remarkChain()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use([defaultRehypePlugins.raw, defaultRehypePlugins.katex] as PluggableList);

const classesOf = (node: Element): string[] => {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/\s+/);
  return [];
};

export interface KatexError {
  /** rehype-katex puts the KaTeX message in `title`. */
  readonly title: string;
  /** What the error span shows the reader — usually the offending source. */
  readonly text: string;
}

export interface RenderAnalysis {
  readonly html: string;
  /** Number of `.katex` roots produced. Zero means nothing was typeset. */
  readonly katexCount: number;
  /** Number of `.katex-display` roots (block math, as opposed to inline). */
  readonly displayCount: number;
  readonly katexErrors: readonly KatexError[];
  /** The `<annotation encoding="application/x-tex">` payloads, in order. */
  readonly texAnnotations: readonly string[];
  /** All rendered text with `<annotation>` removed (it is a copy of the TeX). */
  readonly visibleText: string;
  /**
   * `visibleText` minus code/pre and minus KaTeX error spans — the text a
   * reader sees as PROSE. Leak scanning runs on this: TeX inside a fence is
   * there on purpose, and an error span showing its own source is the
   * degradation working, not a leak.
   */
  readonly proseText: string;
}

const analyze = (tree: Root): RenderAnalysis => {
  let katexCount = 0;
  let displayCount = 0;
  const katexErrors: KatexError[] = [];
  const texAnnotations: string[] = [];
  const visible: string[] = [];
  const prose: string[] = [];

  const walk = (node: Nodes, inCode: boolean, inError: boolean): void => {
    if (node.type === 'text') {
      visible.push(node.value);
      if (!inCode && !inError) prose.push(node.value);
      return;
    }
    if (node.type === 'element') {
      const classes = classesOf(node);
      if (classes.includes('katex')) katexCount += 1;
      if (classes.includes('katex-display')) displayCount += 1;

      if (node.tagName === 'annotation') {
        // The TeX round-trip copy. Collected, never counted as visible text.
        texAnnotations.push(collectRawText(node));
        return;
      }
      const isError = classes.includes('katex-error');
      if (isError) {
        katexErrors.push({
          title: String(node.properties?.title ?? ''),
          text: collectRawText(node),
        });
      }
      const nextInCode =
        inCode || node.tagName === 'code' || node.tagName === 'pre';
      for (const child of node.children) {
        walk(child, nextInCode, inError || isError);
      }
      return;
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child, inCode, inError);
    }
  };

  for (const child of tree.children) walk(child, false, false);

  return {
    html: toHtml(tree),
    katexCount,
    displayCount,
    katexErrors,
    texAnnotations,
    visibleText: visible.join(''),
    proseText: prose.join(''),
  };
};

const collectRawText = (node: Nodes): string => {
  if (node.type === 'text') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((c) => collectRawText(c as Nodes)).join('');
  }
  return '';
};

const run = (processor: MarkdownProcessor, markdown: string): RenderAnalysis =>
  analyze(processor.runSync(processor.parse(markdown)) as Root);

/** Render exactly as the chat surface does, sanitizer and hardener included. */
export const renderScreen = (markdown: string): RenderAnalysis =>
  run(screenProcessor, markdown);

/** Render through Streamdown's stock chain — the configuration we override. */
export const renderWithStockSanitize = (markdown: string): RenderAnalysis =>
  run(stockProcessor, markdown);

/** Render with no sanitize step at all, to isolate KaTeX from the schema. */
export const renderWithoutSanitize = (markdown: string): RenderAnalysis =>
  run(noSanitizeProcessor, markdown);

/**
 * Streamdown's streaming path, faithfully: split into blocks FIRST, then run
 * remend over each block's trimmed content, then render each block on its own.
 * (`Block` in streamdown 1.6.11 does `shouldParseIncompleteMarkdown ?
 * remend(content.trim()) : content`.) `withRemend: false` models `mode="static"`
 * on the finished message, which skips both the split and remend.
 */
export const renderBlocks = (
  markdown: string,
  options: { readonly withRemend: boolean },
): {
  readonly blocks: readonly string[];
  readonly perBlock: readonly RenderAnalysis[];
} => {
  const blocks = parseMarkdownIntoBlocks(markdown);
  const perBlock = blocks.map((block) =>
    renderScreen(options.withRemend ? remend(block.trim()) : block),
  );
  return { blocks, perBlock };
};

/** Whitespace-insensitive text, for comparing renders across parse strategies. */
export const collapse = (text: string): string =>
  text.replace(/\s+/g, ' ').trim();

/**
 * The equivalence relation family 2 and family 3 compare renders with.
 *
 * Deliberately NOT HTML string identity. Rendering a document whole and
 * rendering it block-by-block legitimately differ in inter-element whitespace
 * (remark-rehype inserts `\n` text nodes between siblings that per-block
 * rendering never creates) and could differ in generated ids. What must NOT
 * differ is what the reader gets: the same equations, in the same order, with
 * the same error count, and the same words around them.
 */
export interface RenderSignature {
  readonly tex: readonly string[];
  readonly errorCount: number;
  readonly text: string;
}

export const signatureOf = (analysis: RenderAnalysis): RenderSignature => ({
  tex: analysis.texAnnotations.map(collapse),
  errorCount: analysis.katexErrors.length,
  text: collapse(analysis.visibleText),
});

export const signatureOfBlocks = (
  perBlock: readonly RenderAnalysis[],
): RenderSignature => ({
  tex: perBlock.flatMap((b) => b.texAnnotations.map(collapse)),
  errorCount: perBlock.reduce((n, b) => n + b.katexErrors.length, 0),
  // Joined with a space: a block boundary IS a separation, and the whole-document
  // render represents it as the `\n` text node collapse() turns into a space.
  text: collapse(perBlock.map((b) => b.visibleText).join(' ')),
});

/** Multi-line, greppable failure context. A bare boolean is useless here. */
export const describeRender = (
  id: string,
  input: string,
  analysis: RenderAnalysis,
  extra?: Record<string, unknown>,
): string =>
  [
    `case: ${id}`,
    `input:\n${indent(input)}`,
    `katex nodes: ${analysis.katexCount} (display: ${analysis.displayCount})`,
    `katex errors: ${JSON.stringify(analysis.katexErrors)}`,
    `tex annotations: ${JSON.stringify(analysis.texAnnotations)}`,
    `prose text: ${JSON.stringify(analysis.proseText)}`,
    `html:\n${indent(analysis.html.slice(0, 1500))}`,
    ...Object.entries(extra ?? {}).map(
      ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
    ),
  ].join('\n');

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

/** Leak tokens present in a case's prose. Empty array is the passing state. */
export const findLeaks = (proseText: string): string[] =>
  LEAK_TOKENS.filter((token) => proseText.includes(token));
