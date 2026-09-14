import { DocxTextPlacement } from '@/types/formFill';

import {
  DocxFillValue,
  PARTS_WITH_CONTROLS,
  assertSpanCount,
  escapeXml,
  fillPart,
  paragraphPropsOf,
  readParts,
  runPropsOf,
  textOf,
  textRuns,
} from './docxFill';

import { strFromU8, strToU8, zipSync } from 'fflate';

/**
 * Label-anchored DOCX filling (`docx-anchored` mode, phase 2): for forms
 * built without content controls. A slot is a LABEL paragraph plus a
 * placement — the empty table cell to its right / below it, the empty
 * paragraph after it, or the tail of the label line itself ("Name: ____").
 * Detection is heuristic and shown to the user as the anchor report; the
 * template editor can place fields by hand with the same anchor shape.
 *
 * Filling is the same surgery as content controls: only runs inside the
 * target paragraph/cell are replaced, the first run's properties are kept,
 * and the XML is never restructured.
 */

export interface DocxTextSlot {
  /** Normalized label (trailing colon/underscores stripped). */
  labelText: string;
  /** 0-based index among slots with the same label, document order. */
  occurrence: number;
  placement: DocxTextPlacement;
  part: string;
}

interface Span {
  start: number;
  end: number;
}

/** Nesting-aware spans of every `<w:TAG …>…</w:TAG>` element. */
export function findElements(xml: string, tag: string): Span[] {
  const spans: Span[] = [];
  const stack: number[] = [];
  const re = new RegExp(
    `<w:${tag}(?:\\s[^>]*)?/>|<w:${tag}(?:\\s[^>]*)?>|</w:${tag}>`,
    'g',
  );
  for (const match of xml.matchAll(re)) {
    const index = match.index ?? 0;
    if (match[0].endsWith('/>')) {
      // Self-closing (`<w:p/>`, `<w:p w:rsidR="…"/>` — Word's empty
      // paragraph without pPr): a real, empty element, not nothing.
      spans.push({ start: index, end: index + match[0].length });
      continue;
    }
    if (match[0].startsWith('</')) {
      const start = stack.pop();
      if (start !== undefined) {
        spans.push({ start, end: index + match[0].length });
      }
    } else {
      stack.push(index);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function contains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Innermost element of `candidates` containing `span`. */
function parentOf(span: Span, candidates: Span[]): Span | undefined {
  let best: Span | undefined;
  for (const c of candidates) {
    if (c.start === span.start && c.end === span.end) continue;
    if (contains(c, span) && (!best || contains(best, c))) best = c;
  }
  return best;
}

const MAX_LABEL_CHARS = 120;

export function normalizeLabel(text: string): string {
  return text
    .replace(/[_…]{2,}/g, ' ')
    .replace(/[:：]\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_CHARS);
}

function looksLikeLabel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_LABEL_CHARS) return false;
  // A paragraph of prose is not a label: labels are short and not sentences.
  const words = trimmed.split(/\s+/).length;
  return words <= 12;
}

interface ParagraphInfo extends Span {
  text: string;
  /** Innermost table cell, when the paragraph sits in one. */
  cell?: Span;
}

interface TableInfo {
  rows: Array<{ span: Span; cells: Span[] }>;
}

function paragraphsOf(xml: string): ParagraphInfo[] {
  const cells = findElements(xml, 'tc');
  const paragraphs = findElements(xml, 'p');
  assertSpanCount(paragraphs.length + cells.length);
  return paragraphs.map((p) => ({
    ...p,
    text: textOf(xml.slice(p.start, p.end)),
    cell: parentOf(p, cells),
  }));
}

function tablesOf(xml: string): TableInfo[] {
  const tables = findElements(xml, 'tbl');
  const rows = findElements(xml, 'tr');
  const cells = findElements(xml, 'tc');
  return tables.map((tbl) => ({
    rows: rows
      .filter((r) => contains(tbl, r) && parentOf(r, tables) === tbl)
      .map((r) => ({
        span: r,
        cells: cells.filter((c) => contains(r, c) && parentOf(c, rows) === r),
      })),
  }));
}

function cellText(xml: string, cell: Span): string {
  return textOf(xml.slice(cell.start, cell.end)).trim();
}

/** Locates the cell to the right of / below `cell` in its table. */
function neighbourCell(
  tables: TableInfo[],
  cell: Span,
  direction: 'right' | 'below',
): Span | undefined {
  for (const table of tables) {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];
      const c = row.cells.findIndex(
        (x) => x.start === cell.start && x.end === cell.end,
      );
      if (c === -1) continue;
      if (direction === 'right') return row.cells[c + 1];
      const next = table.rows[r + 1];
      return next?.cells[c];
    }
  }
  return undefined;
}

interface Located {
  slot: DocxTextSlot;
  /** The element whose content receives the value. */
  target: Span;
  /** For after-label: the label paragraph itself. */
  labelParagraph: Span;
}

function locateSlots(xml: string, part: string): Located[] {
  const paragraphs = paragraphsOf(xml);
  const tables = tablesOf(xml);
  const seen = new Map<string, number>();
  const out: Located[] = [];
  const usedTargets = new Set<number>();

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (!looksLikeLabel(p.text)) continue;
    const labelText = normalizeLabel(p.text);
    if (!labelText) continue;
    let placement: DocxTextPlacement | undefined;
    let target: Span | undefined;

    if (p.cell) {
      const right = neighbourCell(tables, p.cell, 'right');
      if (right && cellText(xml, right) === '') {
        placement = 'table-cell-right';
        target = right;
      } else {
        const below = neighbourCell(tables, p.cell, 'below');
        if (below && cellText(xml, below) === '') {
          placement = 'table-cell-below';
          target = below;
        }
      }
    }
    if (!placement) {
      if (/([:：]|_{3,})\s*$/u.test(p.text)) {
        placement = 'after-label';
        target = p;
      } else {
        const next = paragraphs[i + 1];
        if (next && next.text.trim() === '' && next.cell === p.cell) {
          placement = 'next-paragraph';
          target = next;
        }
      }
    }
    if (!placement || !target || usedTargets.has(target.start)) continue;
    usedTargets.add(target.start);
    const occurrence = seen.get(labelText) ?? 0;
    seen.set(labelText, occurrence + 1);
    out.push({
      slot: { labelText, occurrence, placement, part },
      target,
      labelParagraph: p,
    });
  }
  return out;
}

export function detectDocxTextSlots(bytes: Uint8Array): DocxTextSlot[] {
  const entries = readParts(bytes);
  const slots: DocxTextSlot[] = [];
  for (const name of Object.keys(entries)) {
    if (!PARTS_WITH_CONTROLS.test(name)) continue;
    slots.push(
      ...locateSlots(strFromU8(entries[name]), name).map((l) => l.slot),
    );
  }
  return slots.sort((a, b) => {
    const rank = (p: string) => (p === 'word/document.xml' ? 0 : 1);
    return rank(a.part) - rank(b.part);
  });
}

/* ------------------------------------------------------------------ */
/* Filling                                                             */
/* ------------------------------------------------------------------ */

export interface DocxTextFill {
  labelText: string;
  occurrence: number;
  placement: DocxTextPlacement;
  value: DocxFillValue;
}

function valueText(value: DocxFillValue): string {
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
}

/** Replaces every paragraph inside a cell (or the one paragraph) with the value. */
function replaceParagraphContent(
  xml: string,
  target: Span,
  text: string,
): string {
  const inner = xml.slice(target.start, target.end);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const pPr = paragraphPropsOf(inner);
  const rPr = runPropsOf(inner);
  const paragraphs = lines
    .map(
      (line) =>
        `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    )
    .join('');
  if (inner.startsWith('<w:tc')) {
    // Keep the cell's own properties, swap its paragraphs.
    const tcPr = inner.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] ?? '';
    const open = inner.match(/^<w:tc(?:\s[^>]*)?>/)?.[0] ?? '<w:tc>';
    return (
      xml.slice(0, target.start) +
      open +
      tcPr +
      paragraphs +
      '</w:tc>' +
      xml.slice(target.end)
    );
  }
  return xml.slice(0, target.start) + paragraphs + xml.slice(target.end);
}

/** Appends the value to the label paragraph, dropping trailing blanks ("____"). */
function appendAfterLabel(xml: string, paragraph: Span, text: string): string {
  let inner = xml.slice(paragraph.start, paragraph.end);
  // Strip runs that are only underscores/dots (the blank line to write on).
  inner = inner.replace(
    /<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t(?:\s[^>]*)?>[\s_….]*<\/w:t><\/w:r>/g,
    '',
  );
  // Trim the blank tail of the last text run ("Budget: ______" → "Budget:").
  const lastClose = inner.lastIndexOf('</w:t>');
  if (lastClose !== -1) {
    const open = inner.lastIndexOf('>', lastClose);
    const tail = inner.slice(open + 1, lastClose).replace(/[\s_….]+$/u, '');
    inner = inner.slice(0, open + 1) + tail + inner.slice(lastClose);
  }
  const rPr = runPropsOf(inner);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const runs = `<w:r>${rPr}<w:t xml:space="preserve"> </w:t></w:r>${textRuns(lines, rPr)}`;
  const closeAt = inner.lastIndexOf('</w:p>');
  inner = inner.slice(0, closeAt) + runs + inner.slice(closeAt);
  return xml.slice(0, paragraph.start) + inner + xml.slice(paragraph.end);
}

function fillTextAnchorsInPart(
  xml: string,
  fills: DocxTextFill[],
  filled: Set<string>,
): string {
  // Locate ONCE on the pristine part and apply back-to-front. Writing a
  // slot changes what a rescan would see (the cell is no longer empty, the
  // label no longer ends in ":"), which would renumber later occurrences
  // of the same label; a single pass keeps every occurrence addressable.
  const located = locateSlots(xml, '');
  const hits: Array<{ hit: Located; fill: DocxTextFill }> = [];
  for (const fill of fills) {
    const hit = located.find(
      (l) =>
        l.slot.labelText === fill.labelText &&
        l.slot.occurrence === fill.occurrence &&
        l.slot.placement === fill.placement,
    );
    if (hit) hits.push({ hit, fill });
  }
  const targetOf = (h: Located) =>
    h.slot.placement === 'after-label' ? h.labelParagraph : h.target;
  hits.sort((a, b) => targetOf(b.hit).start - targetOf(a.hit).start);
  for (const { hit, fill } of hits) {
    const text = valueText(fill.value);
    xml =
      fill.placement === 'after-label'
        ? appendAfterLabel(xml, hit.labelParagraph, text)
        : replaceParagraphContent(xml, hit.target, text);
    filled.add(`${fill.labelText}#${fill.occurrence}`);
  }
  return xml;
}

export interface DocxDocumentFillResult {
  bytes: Uint8Array;
  /** Control keys and `label#occurrence` text anchors that were written. */
  filled: string[];
  missing: string[];
}

/**
 * Fills a DOCX with content-control values AND label-anchored values in one
 * pass over the package. Either map may be empty.
 */
export function fillDocxDocument(
  bytes: Uint8Array,
  controls: Record<string, DocxFillValue>,
  texts: DocxTextFill[],
): DocxDocumentFillResult {
  const entries = readParts(bytes);
  const filled = new Set<string>();
  const out: Record<string, Uint8Array> = {};
  for (const name of Object.keys(entries)) {
    if (PARTS_WITH_CONTROLS.test(name)) {
      let xml = strFromU8(entries[name]);
      if (Object.keys(controls).length > 0)
        xml = fillPart(xml, controls, filled);
      if (texts.length > 0) xml = fillTextAnchorsInPart(xml, texts, filled);
      out[name] = strToU8(xml);
    } else {
      out[name] = entries[name];
    }
  }
  const wanted = [
    ...Object.keys(controls),
    ...texts.map((t) => `${t.labelText}#${t.occurrence}`),
  ];
  return {
    bytes: zipSync(out, { level: 6 }),
    filled: [...filled],
    missing: wanted.filter((k) => !filled.has(k)),
  };
}
