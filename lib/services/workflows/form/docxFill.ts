import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * DOCX content-control detection and in-place filling
 * (docs/DOCUMENT_FILL_ASSESSMENT.md §7a, `docx-controls` mode).
 *
 * Pure JavaScript over the OOXML text: the archive is unzipped with fflate,
 * every `<w:sdt>` element with a tag or alias is located, and filling
 * replaces ONLY the runs inside its `<w:sdtContent>` — the paragraph and
 * run properties of the first existing run are kept, so styles survive
 * and the XML is never restructured. No new dependency.
 *
 * Client-safe (no Node imports) so the same code can run in the browser
 * for a preview and on the server for the export.
 */

export type DocxControlKind = 'text' | 'checkbox' | 'dropdown' | 'date';

export interface DocxControl {
  /** The anchor key: `w:tag` when set, else `w:alias`. */
  key: string;
  tag?: string;
  alias?: string;
  kind: DocxControlKind;
  /** Current visible text (usually the placeholder). */
  text: string;
  /** Dropdown/combo display options. */
  options?: string[];
  /** Which part of the package it lives in (document, header, footer). */
  part: string;
}

export const PARTS_WITH_CONTROLS =
  /^word\/(document|header\d*|footer\d*)\.xml$/;

interface SdtSpan {
  start: number;
  end: number;
  prStart: number;
  prEnd: number;
  contentStart: number;
  contentEnd: number;
}

/** Locates every sdt element (nesting-aware) with its property/content spans. */
function findSdts(xml: string): SdtSpan[] {
  const spans: SdtSpan[] = [];
  const stack: number[] = [];
  const re = /<w:sdt(?:\s[^>]*)?>|<\/w:sdt>/g;
  for (const match of xml.matchAll(re)) {
    const index = match.index ?? 0;
    if (match[0].startsWith('</')) {
      const start = stack.pop();
      if (start === undefined) continue;
      const end = index + match[0].length;
      const prStart = xml.indexOf('<w:sdtPr>', start);
      const prEndTag = xml.indexOf('</w:sdtPr>', prStart);
      const contentOpen = xml.indexOf('<w:sdtContent', start);
      const contentClose = xml.lastIndexOf('</w:sdtContent>', end);
      if (
        prStart === -1 ||
        prEndTag === -1 ||
        contentOpen === -1 ||
        contentClose === -1 ||
        prStart > end ||
        contentOpen > end
      ) {
        continue;
      }
      const contentStart = xml.indexOf('>', contentOpen) + 1;
      spans.push({
        start,
        end,
        prStart,
        prEnd: prEndTag + '</w:sdtPr>'.length,
        contentStart,
        contentEnd: contentClose,
      });
    } else {
      stack.push(index);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function attr(xml: string, element: string, name: string): string | undefined {
  const re = new RegExp(`<${element}\\b[^>]*\\s${name}="([^"]*)"`, 'u');
  const match = xml.match(re);
  return match ? decodeXml(match[1]) : undefined;
}

export function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&amp;/g, '&');
}

export function escapeXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- stripping XML-illegal chars is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

export function textOf(xml: string): string {
  return decodeXml(
    [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
      .map((m) => m[1])
      .join(''),
  );
}

function kindOf(pr: string): DocxControlKind {
  if (pr.includes('<w14:checkbox')) return 'checkbox';
  if (pr.includes('<w:dropDownList') || pr.includes('<w:comboBox')) {
    return 'dropdown';
  }
  if (pr.includes('<w:date')) return 'date';
  return 'text';
}

function optionsOf(pr: string): string[] | undefined {
  const items = [...pr.matchAll(/<w:listItem\b[^>]*>/g)].map((m) => {
    const display = attr(m[0], 'w:listItem', 'w:displayText');
    const value = attr(m[0], 'w:listItem', 'w:value');
    return display ?? value ?? '';
  });
  return items.length > 0 ? items.filter((i) => i !== '') : undefined;
}

function controlsInPart(xml: string, part: string): DocxControl[] {
  const out: DocxControl[] = [];
  for (const span of findSdts(xml)) {
    const pr = xml.slice(span.prStart, span.prEnd);
    const tag = attr(pr, 'w:tag', 'w:val');
    const alias = attr(pr, 'w:alias', 'w:val');
    const key = tag?.trim() || alias?.trim();
    if (!key) continue;
    // A group/section control that only wraps other controls is a
    // container, not a slot: skip it when it contains a nested sdt.
    const content = xml.slice(span.contentStart, span.contentEnd);
    if (content.includes('<w:sdt')) continue;
    out.push({
      key,
      tag: tag?.trim() || undefined,
      alias: alias?.trim() || undefined,
      kind: kindOf(pr),
      text: textOf(content).trim(),
      options: optionsOf(pr),
      part,
    });
  }
  return out;
}

export function isDocx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Inflation caps: the compressed size is checked upstream, these bound the
 * uncompressed bytes so a deflate bomb cannot exhaust memory. */
export const MAX_PART_BYTES = 40 * 1024 * 1024;
export const MAX_TOTAL_INFLATED_BYTES = 120 * 1024 * 1024;
/** Element caps: fills are O(spans × part) — a hostile package with 10⁵
 * controls would stall the event loop. */
export const MAX_SPANS_PER_PART = 5_000;

export class DocxLimitError extends Error {}

export function readParts(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      if (
        file.originalSize > MAX_PART_BYTES ||
        total > MAX_TOTAL_INFLATED_BYTES
      ) {
        throw new DocxLimitError('DOCX package is too large to process');
      }
      return true;
    },
  });
}

export function assertSpanCount(count: number): void {
  if (count > MAX_SPANS_PER_PART) {
    throw new DocxLimitError('DOCX package has too many elements');
  }
}

/** Every addressable content control in the package, document order. */
export function detectDocxControls(bytes: Uint8Array): DocxControl[] {
  const entries = readParts(bytes);
  const controls: DocxControl[] = [];
  for (const name of Object.keys(entries)) {
    if (!PARTS_WITH_CONTROLS.test(name)) continue;
    controls.push(...controlsInPart(strFromU8(entries[name]), name));
  }
  // document.xml first, then headers/footers, each in package order.
  return controls.sort((a, b) => {
    const rank = (p: string) => (p === 'word/document.xml' ? 0 : 1);
    return rank(a.part) - rank(b.part);
  });
}

/* ------------------------------------------------------------------ */
/* Filling                                                             */
/* ------------------------------------------------------------------ */

export type DocxFillValue = string | boolean;

export interface DocxFillResult {
  bytes: Uint8Array;
  filled: string[];
  /** Keys in `values` that matched no control. */
  missing: string[];
}

function firstMatch(xml: string, re: RegExp): string {
  const m = xml.match(re);
  return m ? m[0] : '';
}

/** Run properties of the first run, minus placeholder styling. */
export function runPropsOf(content: string): string {
  const rPr = firstMatch(content, /<w:rPr>[\s\S]*?<\/w:rPr>/);
  return rPr.replace(/<w:rStyle w:val="PlaceholderText"\/>/g, '');
}

export function paragraphPropsOf(content: string): string {
  return firstMatch(content, /<w:pPr>[\s\S]*?<\/w:pPr>/);
}

export function textRuns(lines: string[], rPr: string): string {
  return lines
    .map(
      (line) =>
        `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`,
    )
    .join(`<w:r>${rPr}<w:br/></w:r>`);
}

function buildContent(content: string, text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const rPr = runPropsOf(content);
  if (content.includes('<w:p')) {
    const pPr = paragraphPropsOf(content);
    return lines
      .map(
        (line) =>
          `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
      )
      .join('');
  }
  return textRuns(lines, rPr);
}

function toBoolean(value: DocxFillValue): boolean {
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', '1', 'y', 'checked', '☒', 'x'].includes(
    value.trim().toLowerCase(),
  );
}

function glyphFor(pr: string, checked: boolean): string {
  const element = checked ? 'w14:checkedState' : 'w14:uncheckedState';
  const hex = attr(pr, element, 'w14:val');
  const code = hex ? parseInt(hex, 16) : checked ? 0x2612 : 0x2610;
  return String.fromCodePoint(
    Number.isNaN(code) ? (checked ? 0x2612 : 0x2610) : code,
  );
}

function fillCheckbox(
  xml: string,
  span: SdtSpan,
  value: DocxFillValue,
): string {
  const checked = toBoolean(value);
  let pr = xml.slice(span.prStart, span.prEnd);
  pr = pr.includes('<w14:checked ')
    ? pr.replace(
        /<w14:checked [^>]*\/>/,
        `<w14:checked w14:val="${checked ? 1 : 0}"/>`,
      )
    : pr.replace(
        '<w14:checkbox>',
        `<w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/>`,
      );
  const content = xml.slice(span.contentStart, span.contentEnd);
  const glyph = glyphFor(pr, checked);
  const rPr = runPropsOf(content);
  const newContent = content.includes('<w:p')
    ? `<w:p>${paragraphPropsOf(content)}<w:r>${rPr}<w:t>${glyph}</w:t></w:r></w:p>`
    : `<w:r>${rPr}<w:t>${glyph}</w:t></w:r>`;
  return (
    xml.slice(0, span.prStart) +
    pr +
    xml.slice(span.prEnd, span.contentStart) +
    newContent +
    xml.slice(span.contentEnd)
  );
}

function fillText(xml: string, span: SdtSpan, text: string): string {
  const pr = xml
    .slice(span.prStart, span.prEnd)
    .replace(/<w:showingPlcHdr\/>/g, '');
  const content = xml.slice(span.contentStart, span.contentEnd);
  return (
    xml.slice(0, span.prStart) +
    pr +
    xml.slice(span.prEnd, span.contentStart) +
    buildContent(content, text) +
    xml.slice(span.contentEnd)
  );
}

function dropdownText(pr: string, value: string): string {
  const options = [...pr.matchAll(/<w:listItem\b[^>]*>/g)].map((m) => ({
    display: attr(m[0], 'w:listItem', 'w:displayText') ?? '',
    value: attr(m[0], 'w:listItem', 'w:value') ?? '',
  }));
  const wanted = value.trim().toLowerCase();
  const hit = options.find(
    (o) =>
      o.display.toLowerCase() === wanted || o.value.toLowerCase() === wanted,
  );
  return hit ? hit.display || hit.value : value;
}

export function fillPart(
  xml: string,
  values: Record<string, DocxFillValue>,
  filled: Set<string>,
): string {
  // ONE scan, applied back-to-front: the container-skip rule leaves only
  // leaf controls, which never overlap, so earlier offsets stay valid
  // after a later replacement. No rescans, no per-write O(n) cost.
  const spans = findSdts(xml);
  assertSpanCount(spans.length);
  const hits: Array<{ span: SdtSpan; key: string; pr: string }> = [];
  for (const span of spans) {
    const pr = xml.slice(span.prStart, span.prEnd);
    const key =
      attr(pr, 'w:tag', 'w:val')?.trim() ||
      attr(pr, 'w:alias', 'w:val')?.trim();
    if (!key || !Object.hasOwn(values, key)) continue;
    const content = xml.slice(span.contentStart, span.contentEnd);
    if (content.includes('<w:sdt')) continue;
    hits.push({ span, key, pr });
  }
  hits.sort((a, b) => b.span.start - a.span.start);
  for (const { span, key, pr } of hits) {
    const value = values[key];
    const kind = kindOf(pr);
    if (kind === 'checkbox') xml = fillCheckbox(xml, span, value);
    else if (kind === 'dropdown') {
      xml = fillText(xml, span, dropdownText(pr, String(value)));
    } else {
      xml = fillText(
        xml,
        span,
        typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value,
      );
    }
    filled.add(key);
  }
  return xml;
}

/**
 * Writes `values` into every control whose key matches (all occurrences —
 * a form that repeats "Applicant name" in a header gets it everywhere).
 */
export function fillDocxControls(
  bytes: Uint8Array,
  values: Record<string, DocxFillValue>,
): DocxFillResult {
  const entries = readParts(bytes);
  const filled = new Set<string>();
  const out: Record<string, Uint8Array> = {};
  for (const name of Object.keys(entries)) {
    if (PARTS_WITH_CONTROLS.test(name)) {
      const xml = fillPart(strFromU8(entries[name]), values, filled);
      out[name] = strToU8(xml);
    } else {
      out[name] = entries[name];
    }
  }
  const missing = Object.keys(values).filter((k) => !filled.has(k));
  return { bytes: zipSync(out, { level: 6 }), filled: [...filled], missing };
}
