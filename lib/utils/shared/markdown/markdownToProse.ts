/**
 * Markdown → the prose a reader saw.
 *
 * Fetched pages arrive as Markdown (Turndown), which is what a model reads
 * best but not what a page SAYS: Turndown escapes anything that could be
 * syntax, so "[province]" becomes "\[province\]", and headings, bullets and
 * emphasis carry their markers. Anything shown to people, verified as
 * verbatim, quoted into a post or linked with a text fragment must be the
 * prose instead. This is that conversion: structural markers dropped,
 * emphasis unwrapped, escapes removed, paragraph breaks kept.
 *
 * Idempotent, so it is safe at every boundary the text crosses.
 */

/** The characters Turndown escapes, in the order it applies them. */
const ESCAPED = /\\([\\*\-+=#`~[\]>_.])/gu;

const FENCE = /^\s*(?:```|~~~)/u;
const RULE = /^\s*(?:[-*_]\s*){3,}$/u;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/u;
const BLOCKQUOTE = /^(\s*>)+\s?/u;
const HEADING = /^\s{0,3}#{1,6}\s+/u;
const BULLET = /^(\s*)[-*+]\s+/u;
const NUMBERED = /^(\s*)\d{1,3}[.)]\s+/u;
const TRAILING_HEADING = /\s+#+\s*$/u;

function unwrapInline(line: string): string {
  return (
    line
      // ![alt](src) then [text](href): the words, never the address.
      .replace(/(?<!\\)!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/(?<!\\)\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/(?<!\\)\*\*(\S(?:[^*]*?\S)?)\*\*/gu, '$1')
      .replace(/(?<!\\)__(\S(?:[^_]*?\S)?)__/gu, '$1')
      .replace(
        /(?<![\\*\p{L}\p{N}])\*(\S(?:[^*]*?\S)?)\*(?![\p{L}\p{N}*])/gu,
        '$1',
      )
      .replace(
        /(?<![\\_\p{L}\p{N}])_(\S(?:[^_]*?\S)?)_(?![\p{L}\p{N}_])/gu,
        '$1',
      )
      .replace(/(?<!\\)`([^`]+)`/gu, '$1')
  );
}

export function markdownToProse(markdown: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/u)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(raw.replace(ESCAPED, '$1'));
      continue;
    }
    if (RULE.test(raw) || TABLE_SEPARATOR.test(raw)) {
      lines.push('');
      continue;
    }
    let line = raw
      .replace(BLOCKQUOTE, '')
      .replace(HEADING, '')
      .replace(TRAILING_HEADING, '')
      .replace(BULLET, '$1')
      .replace(NUMBERED, '$1');
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      // A table row: its cells, separated by spaces.
      line = line
        .trim()
        .replace(/^\||\|$/gu, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join('  ');
    }
    lines.push(unwrapInline(line).replace(ESCAPED, '$1').trimEnd());
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Whether `text` still carries Markdown escapes: a draft saved before the fix. */
export function hasMarkdownEscapes(text: string): boolean {
  return /\\[\\*\-+=#`~[\]>_.]/u.test(text);
}
