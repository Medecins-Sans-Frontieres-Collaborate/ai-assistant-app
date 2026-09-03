/**
 * Render-time normalization of mathematical notation in markdown.
 *
 * Background — issue #121 ("Mathematic equations can break formatting"). Three
 * independent defects conspire to put raw LaTeX on screen:
 *
 * 1. Models emit delimiters our renderer cannot read. The chat UI parses
 *    markdown with remark-math, which understands `$` / `$$` and NOTHING else.
 *    A model that writes `\[ \frac{a}{b} \]` produces `<p>[ \frac{a}{b} ]</p>`
 *    (backslashes eaten as markdown escapes) and `\( x^2 \)` produces
 *    `<p>( x^2 )</p>`. GPT/o-series default to those delimiters whenever the
 *    formatting rules are missing from the system prompt — which is exactly
 *    what happens on every agent path, and permanently on the Foundry agent
 *    path where we cannot inject instructions at all.
 * 2. The block splitter cuts `$$` regions apart. Streamdown pre-splits content
 *    into blocks on blank lines with no knowledge of math, and micromark's
 *    display-math construct treats anything after the opening `$$` on the same
 *    line as a discarded info string (exactly like a code fence). So both
 *    `$$\begin{aligned}…\end{aligned}$$` (all on the opening line) and a `$$`
 *    block containing a blank line render as a red `katex-error` plus a
 *    literal `\end{aligned}`.
 * 3. A bare `$` in prose opens math. "Budget is $5,000 for supplies and
 *    $12,000 for staff" typesets the span between the two sigils. MSF writes
 *    budgets constantly, so this misfires silently and often.
 *
 * The fix is a normalization choke point applied at RENDER time (and on the
 * export path), never to stored content: `Copy` keeps yielding the model's
 * original text, and every message already sitting in a user's browser is
 * repaired without a migration.
 *
 * Design constraints this module must hold, because it runs on every render
 * and on every streamed chunk:
 *
 * - **Idempotent.** `normalize(normalize(x)) === normalize(x)`. It may run on
 *   both the render and the export path, and possibly twice on one string.
 * - **Streaming-safe.** Only ever transform a *terminated* region. A dangling
 *   `\[` or a lone `$` is copied through untouched, so a partially-arrived
 *   equation renders as stable literal text instead of a KaTeX error span that
 *   churns on every token.
 * - **Never touches code.** Protected spans (fences, inline code, HTML blocks,
 *   our own `<<<SENTINEL>>>` stream markers) are masked out first and copied
 *   byte-for-byte. A shell snippet with `$HOME` must survive verbatim.
 * - **Cheap.** One left-to-right scan plus small regexes inside open regions —
 *   not a whole-document regex sweep and not a second markdown parse.
 */

/** A run of the input: either copied verbatim, or open to the rewrite rules. */
interface Segment {
  /** Offset of this segment's first character in the original markdown. */
  start: number;
  /** True when the segment must be copied through byte-for-byte. */
  isProtected: boolean;
  text: string;
}

/**
 * Block-level scanning state carried ACROSS segments.
 *
 * Rule 4 has to know whether a line is an indented code block, and that
 * depends on the enclosing list's indentation, which a protected span in the
 * middle of the document must not reset.
 */
interface LineState {
  /** Content-column of the innermost open list item (marker indent + 2). */
  listIndent: number;
  /** Whether the previous line was blank (an indented block can only open there). */
  prevBlank: boolean;
  /** Whether we are currently inside a 4-space indented code block. */
  inIndentedCode: boolean;
}

/** Longest `\[ … \]` body we will convert; see mathPlausible. */
const MAX_TEX_REGION_LENGTH = 1000;

/**
 * Normalizes math delimiters so the markdown renderer can actually typeset
 * what the model wrote.
 *
 * Applies, in this order and only outside protected spans:
 *   1. `\[ … \]` → `$$ … $$` and `\( … \)` → `$ … $` (balanced regions only)
 *   2. multi-line `$$ … $$` regions reformatted onto their own lines with
 *      interior blank lines collapsed
 *   3. currency sigils escaped as `\$` so prose stops turning into equations
 *
 * The ordering is load-bearing: rule 1 creates `$$` regions that rule 2 must
 * then reformat, and rule 3 must run last so its scanner sees — and steps
 * over — every `$$` region the earlier rules produced.
 *
 * @param markdown - Raw markdown, possibly a partial streaming prefix.
 * @returns The same markdown with math delimiters normalized. Returns the
 *   input reference unchanged when there is no math-ish character at all.
 */
export function normalizeMathDelimiters(markdown: string): string {
  // Fast path: the large majority of messages contain none of these, and
  // this function runs on every render of every message.
  if (
    !markdown.includes('$') &&
    !markdown.includes('\\[') &&
    !markdown.includes('\\(')
  ) {
    return markdown;
  }

  const segments = segmentProtectedRegions(markdown);
  const state: LineState = {
    listIndent: 0,
    prevBlank: true,
    inIndentedCode: false,
  };

  let out = '';
  for (const segment of segments) {
    if (segment.isProtected) {
      out += segment.text;
      // A protected span is opaque: whatever block context it established
      // (a fence's interior, an inline span mid-paragraph) is not something
      // the indented-code heuristic can reason about, so start clean after it.
      state.prevBlank = false;
      state.inIndentedCode = false;
      continue;
    }

    const startsAtLineStart =
      segment.start === 0 || markdown[segment.start - 1] === '\n';

    let text = segment.text;
    text = convertTexRegions(text, '[', ']', true);
    text = convertTexRegions(text, '(', ')', false);
    text = normalizeDisplayRegions(text);
    text = escapeCurrency(text, state, startsAtLineStart);
    out += text;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Rule 1 — segmentation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Splits the input into protected and open segments in a single left-to-right
 * pass.
 *
 * Masking first (rather than writing ever-cleverer regexes) is the only way to
 * be sure a `$` inside ```` ```sh / echo $HOME ```` or inside a mermaid node
 * label is never rewritten: the rewrite rules literally never see those bytes.
 */
function segmentProtectedRegions(markdown: string): Segment[] {
  const segments: Segment[] = [];
  let openStart = 0;
  let i = 0;

  const flushOpen = (end: number): void => {
    if (end > openStart) {
      segments.push({
        start: openStart,
        isProtected: false,
        text: markdown.slice(openStart, end),
      });
    }
  };

  const pushProtected = (start: number, end: number): void => {
    flushOpen(start);
    segments.push({
      start,
      isProtected: true,
      text: markdown.slice(start, end),
    });
    openStart = end;
  };

  while (i < markdown.length) {
    const ch = markdown[i];

    if (ch === '`' || ch === '~') {
      const fenceEnd = matchFence(markdown, i);
      if (fenceEnd !== -1) {
        pushProtected(i, fenceEnd);
        i = fenceEnd;
        continue;
      }
    }

    if (ch === '`') {
      const spanEnd = matchInlineCode(markdown, i);
      if (spanEnd !== -1) {
        pushProtected(i, spanEnd);
        i = spanEnd;
        continue;
      }
      // Unterminated run: skip the whole run so its later backticks are not
      // re-tested as fresh openers (CommonMark leaves them literal anyway).
      let run = 0;
      while (markdown[i + run] === '`') run++;
      i += run;
      continue;
    }

    if (ch === '<') {
      const sentinelEnd = matchSentinel(markdown, i);
      if (sentinelEnd !== -1) {
        pushProtected(i, sentinelEnd);
        i = sentinelEnd;
        continue;
      }
      const htmlEnd = matchHtmlBlock(markdown, i);
      if (htmlEnd !== -1) {
        pushProtected(i, htmlEnd);
        i = htmlEnd;
        continue;
      }
    }

    i++;
  }

  flushOpen(markdown.length);
  return segments;
}

/**
 * If a fenced code block opens at `i`, returns the offset just past its
 * closing fence line (or the end of input when unterminated).
 *
 * The indent is deliberately allowed to be ANY width, not CommonMark's 0-3.
 * A fence nested in a list item is routinely indented four or more spaces, and
 * failing to protect it lets rule 3 write a visible `\$` into someone's code.
 * The cost of over-protecting (a fence-looking line inside indented code) is
 * only that we leave text alone, which is always the safe direction.
 *
 * Running to end-of-input when there is no closing fence is what keeps a
 * half-arrived fence from briefly exposing its `$`s mid-stream.
 */
function matchFence(text: string, i: number): number {
  const lineStart = text.lastIndexOf('\n', i - 1) + 1;
  if (!/^[ \t]*$/.test(text.slice(lineStart, i))) return -1;

  const fenceChar = text[i];
  let openLength = 0;
  while (text[i + openLength] === fenceChar) openLength++;
  if (openLength < 3) return -1;

  let newline = text.indexOf('\n', i);
  if (newline === -1) return text.length;

  let cursor = newline + 1;
  while (cursor <= text.length) {
    newline = text.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, lineEnd);

    let k = 0;
    while (line[k] === ' ' || line[k] === '\t') k++;
    let closeLength = 0;
    while (line[k + closeLength] === fenceChar) closeLength++;
    if (
      closeLength >= openLength &&
      /^[ \t]*$/.test(line.slice(k + closeLength))
    ) {
      return lineEnd;
    }

    if (newline === -1) break;
    cursor = newline + 1;
  }

  return text.length;
}

/**
 * If an inline code span opens at `i`, returns the offset just past its
 * closing backtick run; -1 when there is no matching run.
 *
 * The blank-line bail mirrors CommonMark: a code span lives inside one
 * paragraph, so a stray backtick can never swallow the rest of a document.
 * Unlike a fence, an unterminated span is NOT protected to end of input —
 * CommonMark renders it as literal text, and protecting it would freeze the
 * whole tail of a streaming message.
 */
function matchInlineCode(text: string, i: number): number {
  let openLength = 0;
  while (text[i + openLength] === '`') openLength++;

  let j = i + openLength;
  while (j < text.length) {
    if (text[j] === '`') {
      let run = 0;
      while (text[j + run] === '`') run++;
      if (run === openLength) return j + run;
      j += run;
      continue;
    }
    if (text[j] === '\n') {
      let p = j + 1;
      while (text[p] === ' ' || text[p] === '\t') p++;
      if (p >= text.length || text[p] === '\n') return -1;
    }
    j++;
  }

  return -1;
}

/**
 * Protects the app's own `<<<MARKER>>>` stream blocks (METADATA, AGENT_ACTIVITY,
 * CONSENT_REQUEST, TOOL_CALL_RECORD, SEARCH_INTERIM, CITATION_QUOTES, …).
 *
 * These are stripped upstream before the on-screen render, but this function
 * also runs on the export path, and the open-ended arm (no closer found →
 * protect to end of input) keeps a half-arrived marker safe mid-stream.
 */
function matchSentinel(text: string, i: number): number {
  const open = /<<<[A-Z][A-Z0-9_]*>>>/y;
  open.lastIndex = i;
  const opened = open.exec(text);
  if (!opened) return -1;

  // Both marker conventions in the codebase: `<<<END_X>>>` and `<<<X_END>>>`.
  const close = /<<<(?:END_[A-Z0-9_]+|[A-Z0-9_]+_END)>>>/g;
  close.lastIndex = i + opened[0].length;
  const closed = close.exec(text);
  return closed ? closed.index + closed[0].length : text.length;
}

/** Protects raw `<pre>` / `<script>` / `<style>` blocks embedded in markdown. */
function matchHtmlBlock(text: string, i: number): number {
  const open = /<(pre|script|style)\b[^>]*>/iy;
  open.lastIndex = i;
  const opened = open.exec(text);
  if (!opened) return -1;

  const close = new RegExp(`</${opened[1]}\\s*>`, 'gi');
  close.lastIndex = i + opened[0].length;
  const closed = close.exec(text);
  return closed ? closed.index + closed[0].length : text.length;
}

/* -------------------------------------------------------------------------- */
/* Rule 2 — \[ … \] and \( … \) conversion                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rewrites balanced TeX delimiter pairs into dollar delimiters.
 *
 * Prevents: `\[ \frac{a}{b} \]` rendering as the literal text
 * `[ \frac{a}{b} ]`, and `\( x^2 \)` rendering as `( x^2 )`.
 *
 * Only ever converts a region that is already CLOSED — an unterminated `\[`
 * mid-stream is left exactly as it arrived, so the visible text stays stable
 * instead of flickering through a KaTeX error span.
 */
function convertTexRegions(
  text: string,
  openChar: string,
  closeChar: string,
  display: boolean,
): string {
  if (!text.includes(`\\${openChar}`)) return text;

  let out = '';
  let i = 0;
  /** Source offset just past the previously converted region, or -1. */
  let previousEnd = -1;

  while (i < text.length) {
    if (
      text[i] !== '\\' ||
      text[i + 1] !== openChar ||
      // `\\[2pt]` is a LaTeX line break with spacing, extremely common inside
      // `aligned`. Its bracket is preceded by an ESCAPED backslash, so an
      // odd-run check here is the difference between normalizing an equation
      // and shredding its interior into `$$2pt$$`.
      isEscapedAt(text, i)
    ) {
      out += text[i];
      i++;
      continue;
    }

    const close = findTexClose(text, i + 2, closeChar);
    if (close === -1) {
      // Streaming safety: no closer yet, so nothing after this point can be
      // judged. Copy the rest through untouched.
      out += text.slice(i);
      return out;
    }

    const inner = text.slice(i + 2, close);

    if (/\\[[(]/.test(inner)) {
      // A nested opener means the non-greedy match landed on the wrong closer
      // (`\( \frac{\(x\)}{2} \)`). Copy the whole ambiguous region verbatim
      // rather than converting the inner fragment and mangling the outer one.
      out += text.slice(i, close + 2);
      i = close + 2;
      continue;
    }

    if (!mathPlausible(inner)) {
      out += text[i];
      i++;
      continue;
    }

    // `\[a\]\[b\]` naively becomes `$$a$$$$b$$`, which renders as NEITHER
    // equation. One space between adjacent regions restores both.
    if (previousEnd === i) out += ' ';
    // `$$` for BOTH forms, deliberately. Streamdown pins remark-math with
    // `singleDollarTextMath: false` (measured: `defaultRemarkPlugins.math[1]`
    // in streamdown 1.6.11), so `$x$` is INERT here — emitting it would swap
    // one piece of visible source, `( x^2 )`, for another, `$x^2$`. A `$$…$$`
    // span that stays on one line is inline math to remark-math, which is
    // exactly what `\( … \)` meant. If `singleDollarTextMath` is ever turned
    // on, this can go back to `$…$` for the inline arm — nothing else depends
    // on it.
    out += display ? `$$${inner}$$` : `$$${inner.trim()}$$`;
    i = close + 2;
    previousEnd = i;
  }

  return out;
}

/** First unescaped `\]` / `\)` at or after `from`, or -1. */
function findTexClose(text: string, from: number, closeChar: string): number {
  for (let k = from; k < text.length - 1; k++) {
    if (
      text[k] === '\\' &&
      text[k + 1] === closeChar &&
      !isEscapedAt(text, k)
    ) {
      return k;
    }
  }
  return -1;
}

/**
 * Whether a `\[ … \]` body looks like mathematics rather than prose.
 *
 * Prevents: "use \[ and \] to escape" becoming `use $$ and $$ to escape`,
 * which typesets the word "and". A false negative merely shows the model's
 * literal text; a false positive corrupts a sentence — so this errs toward
 * leaving things alone. Known accepted miss: `\(ABC\)` (a triangle, three
 * letters, no operator).
 */
function mathPlausible(inner: string): boolean {
  if (inner.length === 0 || inner.length > MAX_TEX_REGION_LENGTH) return false;
  const trimmed = inner.trim();
  if (trimmed === '') return false;
  // A TeX command, an operator, a brace or a digit — or a bare short symbol
  // such as `x`, `n`, `dx`.
  return /[\\^_{}=+\-*/<>|]|\d/.test(trimmed) || trimmed.length <= 2;
}

/* -------------------------------------------------------------------------- */
/* Rule 3 — display-region reformatting                                       */
/* -------------------------------------------------------------------------- */

/**
 * Puts every multi-line `$$ … $$` region into the one shape the pipeline
 * renders correctly: delimiters alone on their own lines, no interior blank
 * lines.
 *
 * Prevents two distinct failures:
 *  - `$$\begin{aligned}…` — micromark treats the remainder of the opening line
 *    as a discarded info string, so `\begin{aligned}` is swallowed and the
 *    trailing `$$` leaks into the math, producing a red ParseError. Likewise
 *    `$$x = 1\n$$` currently renders a silent EMPTY box.
 *  - a blank line inside the region — Streamdown's block splitter cuts on
 *    blank lines with no `$$` awareness, so the equation arrives at the parser
 *    as two unrelated blocks: a `katex-error` and a literal `\end{aligned}`.
 *
 * Single-line regions are deliberately left ALONE: `$$x^2$$` is inline math
 * today (and the system prompt tells models to write it that way), so moving
 * it onto its own lines would silently promote inline to display and reflow
 * the sentence.
 */
/**
 * The markdown container prefix a line can carry: indentation, then any number
 * of blockquote markers. Rule 3 re-applies exactly this to the lines it
 * rewrites, so an equation stays inside whatever list item or quote it started
 * in.
 */
const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]?)*/;

function normalizeDisplayRegions(text: string): string {
  if (!text.includes('$$')) return text;

  let out = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '$' || text[i + 1] !== '$' || isEscapedAt(text, i)) {
      out += text[i];
      i++;
      continue;
    }

    const close = findDoubleDollar(text, i + 2);
    if (close === -1) {
      // Streaming safety: the region has not closed yet.
      out += text.slice(i);
      return out;
    }

    const content = text.slice(i + 2, close);
    if (!content.includes('\n')) {
      out += text.slice(i, close + 2);
      i = close + 2;
      continue;
    }

    // The container prefix of the line the opening `$$` sits on, re-applied to
    // every body line AND to the closing delimiter. Indentation matters inside
    // list items, where a fully unindented equation falls out of the item; the
    // blockquote markers matter because a closing `$$` that loses its `> `
    // ends the quote early and leaves a second, EMPTY display box behind it.
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    const prefix = BLOCK_PREFIX.exec(text.slice(lineStart, i))?.[0] ?? '';
    // Only strip quote markers off the body when the opener actually carried
    // one. Outside a blockquote a leading `>` is content (`a > b` is valid
    // math), and eating it would corrupt the equation.
    const stripPrefix = prefix.includes('>') ? BLOCK_PREFIX : /^[ \t]*/;

    const body = content
      .split('\n')
      .map((line) => line.replace(stripPrefix, ''))
      .join('\n')
      // Drop blank lines (whitespace is meaningless inside math, and a blank
      // line here is what splits the equation across render blocks). Runs
      // AFTER the prefix strip so a `>`-only line inside a quoted equation
      // counts as blank.
      .replace(/\n[ \t]*(?=\n)/g, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/^\s+/, '')
      .replace(/\s+$/, '')
      .split('\n')
      .map((line) => prefix + line)
      .join('\n');

    out += `$$\n${body}\n${prefix}$$`;
    i = close + 2;
  }

  return out;
}

/** First unescaped `$$` at or after `from`, or -1. */
function findDoubleDollar(text: string, from: number): number {
  for (let k = from; k < text.length - 1; k++) {
    if (text[k] === '$' && text[k + 1] === '$' && !isEscapedAt(text, k))
      return k;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Rule 4 — currency escaping                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Escapes dollar sigils that open an accidental math span.
 *
 * Prevents: "Budget is $5,000 for supplies and $12,000 for staff" typesetting
 * `5,000forsuppliesand` as an equation. MSF discusses budgets constantly, so
 * this misfires far more often than the math case — and silently.
 *
 * Only the OPENER is escaped, never the closer, and scanning resumes one
 * character later rather than past the span. In "We spent $5,000 on $\alpha$
 * testing" the closer of the currency span is the opener of a real equation;
 * escaping both would destroy it, whereas escaping one leaves `$\alpha$`
 * intact and drops the now-unpaired sigil out as literal text.
 */
function escapeCurrency(
  text: string,
  state: LineState,
  startsAtLineStart: boolean,
): string {
  if (!text.includes('$')) {
    // Still has to advance the block state, or a later segment misreads its
    // list/indent context.
    buildIndentedCodeMap(text.split('\n'), state, startsAtLineStart);
    return text;
  }

  const lines = text.split('\n');
  const isIndentedCode = buildIndentedCodeMap(lines, state, startsAtLineStart);

  let out = '';
  let i = 0;
  let line = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\n') {
      out += ch;
      i++;
      line++;
      continue;
    }

    // Escaping inside an indented code block would put a visible backslash in
    // someone's shell snippet, and buys nothing: remark-math never creates
    // math there in the first place.
    if (ch !== '$' || isIndentedCode[line]) {
      out += ch;
      i++;
      continue;
    }

    // An already-escaped sigil is skipped rather than re-escaped. This single
    // check is what makes the whole function idempotent.
    if (isEscapedAt(text, i)) {
      out += ch;
      i++;
      continue;
    }

    if (text[i + 1] === '$') {
      const close = findDoubleDollar(text, i + 2);
      if (close === -1) {
        // Unterminated (streaming). Step over both sigils so the second one is
        // not mistaken for a currency opener.
        out += '$$';
        i += 2;
        continue;
      }
      // Copy a real display region verbatim. Running rule 4 LAST is what makes
      // this possible: `$$2\pi r$$` can never have its inner `$` misread.
      const region = text.slice(i, close + 2);
      out += region;
      line += countNewlines(region);
      i = close + 2;
      continue;
    }

    const closer = findClosingSingleDollar(text, i + 1);
    if (closer === -1) {
      // An unpaired `$` is already literal; touching it would be pure churn,
      // and mid-stream the closer may simply not have arrived yet.
      out += ch;
      i++;
      continue;
    }

    const content = text.slice(i + 1, closer);
    if (isCurrencySpan(content)) {
      out += '\\$';
      i++;
      continue;
    }

    const span = text.slice(i, closer + 1);
    out += span;
    line += countNewlines(span);
    i = closer + 1;
  }

  return out;
}

/**
 * Per-line "this is a 4-space indented code block" map, threading block state
 * through `state` so it survives across protected segments.
 */
function buildIndentedCodeMap(
  lines: string[],
  state: LineState,
  startsAtLineStart: boolean,
): boolean[] {
  return lines.map((line, index) => {
    // A segment that begins mid-line is the tail of the previous line (e.g.
    // prose after an inline code span); it establishes no new block context.
    if (index === 0 && !startsAtLineStart) return state.inIndentedCode;

    if (/^[ \t]*$/.test(line)) {
      state.prevBlank = true;
      state.inIndentedCode = false;
      return false;
    }

    const indent = indentWidth(line);
    const threshold = state.listIndent + 4;
    if (state.prevBlank && indent >= threshold) {
      state.inIndentedCode = true;
    } else if (indent < threshold) {
      state.inIndentedCode = false;
    }

    if (!state.inIndentedCode) {
      const marker = /^[ \t]*([-*+]|\d+[.)])[ \t]/.exec(line);
      if (marker) {
        state.listIndent = indent + 2;
      } else if (indent === 0) {
        state.listIndent = 0;
      }
    }

    state.prevBlank = false;
    return state.inIndentedCode;
  });
}

/**
 * Next unescaped single `$`, stopping at a blank line because remark-math's
 * inline construct cannot cross one.
 */
function findClosingSingleDollar(text: string, from: number): number {
  for (let k = from; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\n') {
      let p = k + 1;
      while (text[p] === ' ' || text[p] === '\t') p++;
      if (p >= text.length || text[p] === '\n') return -1;
      continue;
    }
    if (ch === '$' && !isEscapedAt(text, k)) return k;
  }
  return -1;
}

/**
 * Whether the text between two `$` sigils is money (or a shell variable)
 * rather than mathematics.
 *
 * Tiered so that the strongest signal wins before the weaker vetoes apply.
 * Known residual false positive, documented rather than fixed: bare
 * space-grouped numerals with no operator (`$1 000 000$`) are demoted — they
 * are genuinely ambiguous, and MSF writes far more budgets than unadorned
 * grouped numerals.
 */
function isCurrencySpan(content: string): boolean {
  // Tier A — grouped-thousands amount. Fires regardless of other content:
  // TeX essentially never writes `5,000` (you would write `5{,}000`). This
  // tier exists to beat tier B's math-signal veto for `$5,000 + $3,000`.
  if (/^[ \t]{0,2}\d{1,3}(?:,\d{3})+(?:\.\d+)?/.test(content)) return true;

  // Tier B — leading amount with no math signal anywhere in the span. The
  // trailing-dash clause catches price ranges (`$10-$20` → span content `10-`).
  if (
    /^[ \t]{0,2}\d/.test(content) &&
    !/[\\^_{}=+<>*|~/]/.test(content) &&
    (/\s/.test(content) || /[-–—]$/.test(content))
  ) {
    return true;
  }

  // Tier C — shell variable. Requires 3+ upper-case chars AND prose
  // whitespace, so `$AB$` / `$ABC$` (geometry) stay mathematics.
  if (
    /^[A-Z][A-Z0-9_]{2,}/.test(content) &&
    !/[\\^_{}=+<>*|~/]/.test(content) &&
    /\s/.test(content)
  ) {
    return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Whether the character at `i` is escaped, i.e. preceded by an ODD number of
 * backslashes. `\$` is escaped; `\\$` is a literal backslash then a live `$`.
 */
function isEscapedAt(text: string, i: number): boolean {
  let count = 0;
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) count++;
  return count % 2 === 1;
}

/** Leading-whitespace width of a line, tabs counted as 4 columns. */
function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\n') count++;
  }
  return count;
}
