/**
 * Delimited (CSV/TSV) import and export for glossary entries — shared by the
 * personal glossary manager and the admin glossary editor so both accept
 * and produce the same files.
 *
 * Accepted shapes (delimiter auto-detected: tab if the header line has one,
 * else comma; RFC 4180 quoting; BOM stripped):
 *
 * - With a header row naming any of `source, target, note, kind,
 *   sourceExpansion, targetExpansion` (case-insensitive; a few synonyms) —
 *   columns are mapped by name.
 * - Without a header: positional `source, target[, note[, kind[,
 *   sourceExpansion[, targetExpansion]]]]`. A bare two-column file is the
 *   Azure Document Translation glossary format, so an org's existing
 *   glossary files import unchanged.
 *
 * Export writes the six-column header form. Cells that start with a formula
 * trigger character are prefixed with an apostrophe so a spreadsheet opening
 * the file never evaluates a term as a formula (CSV injection).
 */
import {
  MAX_GLOSSARY_NOTE_CHARS,
  MAX_GLOSSARY_TERM_CHARS,
  resolveEntryKind,
} from '@/lib/utils/shared/translation/glossaryMatch';

import { GlossaryEntry, GlossaryEntryKind } from '@/types/workflow';

export interface GlossaryImportResult {
  entries: GlossaryEntry[];
  /** Rows dropped: empty source/target, over-long cells, or malformed. */
  skipped: number;
  /** Rows beyond `maxEntries` that were not read. */
  truncated: number;
}

type Column =
  | 'source'
  | 'target'
  | 'note'
  | 'kind'
  | 'sourceExpansion'
  | 'targetExpansion';

const HEADER_SYNONYMS: Record<string, Column> = {
  source: 'source',
  'source term': 'source',
  term: 'source',
  src: 'source',
  target: 'target',
  'target term': 'target',
  translation: 'target',
  tgt: 'target',
  note: 'note',
  notes: 'note',
  comment: 'note',
  kind: 'kind',
  type: 'kind',
  sourceexpansion: 'sourceExpansion',
  'source expansion': 'sourceExpansion',
  'source full name': 'sourceExpansion',
  targetexpansion: 'targetExpansion',
  'target expansion': 'targetExpansion',
  'target full name': 'targetExpansion',
};

const POSITIONAL: Column[] = [
  'source',
  'target',
  'note',
  'kind',
  'sourceExpansion',
  'targetExpansion',
];

/** Splits one delimited line into cells (RFC 4180 quotes). */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * Splits text into logical records, honouring newlines inside quoted cells.
 */
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      records.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') records.push(current);
  return records;
}

function detectDelimiter(firstLine: string): string {
  return firstLine.includes('\t') ? '\t' : ',';
}

function mapHeader(cells: string[]): Column[] | null {
  const mapped = cells.map(
    (cell) => HEADER_SYNONYMS[cell.trim().toLowerCase()] ?? null,
  );
  // A header must at least name source and target; otherwise this is data.
  if (!mapped.includes('source') || !mapped.includes('target')) return null;
  return mapped.map(
    (column, index) => column ?? (`ignored-${index}` as Column),
  );
}

function normalizeKind(raw: string | undefined): GlossaryEntryKind | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === 'term' || value === 'acronym') return value;
  return undefined;
}

function cleanCell(raw: string | undefined, max: number): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Parses delimited text into glossary entries. Never throws on content: bad
 * rows are counted in `skipped`. Entries carry an explicit `kind` (the
 * file's, else auto-detected) so later heuristic changes never re-type
 * what was imported.
 */
export function parseGlossaryDelimited(
  input: string,
  maxEntries: number,
): GlossaryImportResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records = splitRecords(text).filter((r) => r.trim() !== '');
  if (records.length === 0) return { entries: [], skipped: 0, truncated: 0 };

  const delimiter = detectDelimiter(records[0]);
  const firstCells = splitLine(records[0], delimiter);
  const headerColumns = mapHeader(firstCells);
  const columns = headerColumns ?? POSITIONAL;
  const rows = headerColumns ? records.slice(1) : records;

  const entries: GlossaryEntry[] = [];
  let skipped = 0;
  let truncated = 0;
  for (const record of rows) {
    if (entries.length >= maxEntries) {
      truncated += 1;
      continue;
    }
    const cells = splitLine(record, delimiter);
    const get = (column: Column): string | undefined => {
      const index = columns.indexOf(column);
      return index === -1 ? undefined : cells[index];
    };
    const source = cleanCell(get('source'), MAX_GLOSSARY_TERM_CHARS + 1);
    const target = cleanCell(get('target'), MAX_GLOSSARY_TERM_CHARS + 1);
    if (
      !source ||
      !target ||
      source.length > MAX_GLOSSARY_TERM_CHARS ||
      target.length > MAX_GLOSSARY_TERM_CHARS
    ) {
      skipped += 1;
      continue;
    }
    const note = cleanCell(get('note'), MAX_GLOSSARY_NOTE_CHARS);
    const sourceExpansion = cleanCell(
      get('sourceExpansion'),
      MAX_GLOSSARY_TERM_CHARS,
    );
    const targetExpansion = cleanCell(
      get('targetExpansion'),
      MAX_GLOSSARY_TERM_CHARS,
    );
    const explicitKind = normalizeKind(get('kind'));
    const draft: GlossaryEntry = { source, target };
    const kind = explicitKind ?? resolveEntryKind(draft);
    entries.push({
      source,
      target,
      kind,
      ...(note ? { note } : {}),
      ...(kind === 'acronym' && sourceExpansion ? { sourceExpansion } : {}),
      ...(kind === 'acronym' && targetExpansion ? { targetExpansion } : {}),
    });
  }
  return { entries, skipped, truncated };
}

/**
 * Merges imported entries into an existing list: an import row REPLACES an
 * existing entry with the same source (case-insensitive), everything else
 * appends in file order. Returns the new list plus how many were replaced.
 */
export function mergeImportedEntries(
  existing: GlossaryEntry[],
  imported: GlossaryEntry[],
): { entries: GlossaryEntry[]; replaced: number; added: number } {
  const byKey = new Map<string, number>();
  const next = [...existing];
  existing.forEach((entry, index) => {
    byKey.set(entry.source.trim().toLowerCase(), index);
  });
  let replaced = 0;
  let added = 0;
  for (const entry of imported) {
    const key = entry.source.trim().toLowerCase();
    const index = byKey.get(key);
    if (index !== undefined) {
      next[index] = entry;
      replaced += 1;
    } else {
      byKey.set(key, next.length);
      next.push(entry);
      added += 1;
    }
  }
  return { entries: next, replaced, added };
}

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

function csvCell(value: string | undefined): string {
  let text = value ?? '';
  if (text !== '' && FORMULA_TRIGGERS.has(text[0])) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Six-column CSV with a header row; round-trips through the parser. */
export function serializeGlossaryCsv(entries: GlossaryEntry[]): string {
  const lines = [
    'source,target,note,kind,sourceExpansion,targetExpansion',
    ...entries.map((entry) =>
      [
        csvCell(entry.source),
        csvCell(entry.target),
        csvCell(entry.note),
        csvCell(resolveEntryKind(entry)),
        csvCell(entry.sourceExpansion),
        csvCell(entry.targetExpansion),
      ].join(','),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}
