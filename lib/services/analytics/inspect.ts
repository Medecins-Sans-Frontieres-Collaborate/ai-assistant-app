/**
 * Answers the validator's questions about a delivered file: which text
 * columns it has, whether any column or value identifies a person, and
 * whether its formulas carry stored results. Server-only.
 *
 * The tables it is handed are a capped read (PREVIEW_ROWS per sheet), so two
 * passes cover what a capped read cannot see:
 *  - column HEADERS are read from every sheet, so an identifier column is
 *    always found, however long the sheet;
 *  - e-mail addresses are searched for in the file's full contents — the raw
 *    sheet XML of a workbook, the whole text of a CSV, every text column of a
 *    parquet file.
 */
import {
  parquetShape,
  readParquetColumns,
} from '@/lib/services/analytics/extract';
import {
  USER_CODE_PATTERN,
  classifyColumn,
  isIdentifierColumn,
} from '@/lib/services/analytics/fields';
import { DerivedTable, isTextValue } from '@/lib/services/analytics/tables';

import { unzipSync } from 'fflate';

/** Zip-bomb guard: refuse a workbook that inflates beyond this. */
const MAX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const MAX_REPORTED_COUNT = 1000;
/** Largest parquet file (in rows) whose text is scanned in full. */
export const MAX_PARQUET_SCAN_ROWS = 500_000;

export class InspectionTooLargeError extends Error {
  constructor() {
    super('File is beyond the inspection limit');
    this.name = 'InspectionTooLargeError';
  }
}

export interface InspectedSheet {
  name: string;
  /** Laid-out page (declared by the report type, or no header found). */
  freeform: boolean;
  /** Every column name, for the report type's required-column check. */
  headers: string[];
  /** Names of the columns holding text (not numbers/dates/booleans). */
  textColumns: string[];
  /** Column names that are direct identifiers. */
  identifierColumns: string[];
  /** User-code columns holding values that are not `u-…` codes. */
  badUserCodes: { column: string; count: number }[];
}

export interface ContentScan {
  /** Where e-mail addresses were found (sheet name, `csv`, column name…). */
  emailHits: { where: string; count: number }[];
  /** Sheets whose formula cells carry no stored value. */
  formulasWithoutValues: { sheet: string; count: number }[];
}

/** What the capped tables say about columns. */
export function inspectTables(
  tables: readonly DerivedTable[],
): InspectedSheet[] {
  return tables.map((table) => {
    const sheet: InspectedSheet = {
      name: table.name,
      freeform: table.layout === 'freeform',
      headers: [],
      textColumns: [],
      identifierColumns: [],
      badUserCodes: [],
    };
    if (table.layout === 'freeform') return sheet;
    table.columns.forEach((column, index) => {
      sheet.headers.push(column.name);
      // An identifier header is a contract violation even on an empty column.
      if (isIdentifierColumn(column.name)) {
        sheet.identifierColumns.push(column.name);
        return;
      }
      if (column.kind !== 'text') return;
      sheet.textColumns.push(column.name);
      if (classifyColumn(column.name, null) === 'userCode') {
        let bad = 0;
        for (const row of table.rows) {
          const value = row[index];
          if (isTextValue(value) && !USER_CODE_PATTERN.test(value.trim())) {
            bad++;
          }
        }
        if (bad > 0)
          sheet.badUserCodes.push({ column: column.name, count: bad });
      }
    });
    return sheet;
  });
}

const EMAIL_LOCAL_END = /[A-Z0-9._%+-]$/i;
const EMAIL_DOMAIN_START = /^[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;
/** Longest domain looked at after an `@`. */
const EMAIL_DOMAIN_WINDOW = 255;

/**
 * Counts e-mail addresses by visiting each `@` and looking at its neighbours.
 * Deliberately not one regular expression over the text: `[local]+@…` retries
 * from every position of a long unbroken run (an embedded base64 value, say),
 * which is quadratic on exactly the kind of cell nobody expects.
 */
function countEmails(text: string): number {
  let count = 0;
  let at = text.indexOf('@');
  while (at !== -1 && count < MAX_REPORTED_COUNT) {
    if (
      at > 0 &&
      EMAIL_LOCAL_END.test(text[at - 1]) &&
      EMAIL_DOMAIN_START.test(text.slice(at + 1, at + 1 + EMAIL_DOMAIN_WINDOW))
    ) {
      count++;
    }
    at = text.indexOf('@', at + 1);
  }
  return count;
}
/** A formula cell with an empty `<v/>`, an empty `<v></v>`, or no `<v>`. */
const FORMULA_WITHOUT_VALUE =
  /<f\b[^>]*(?:\/>|>[^<]*<\/f>)\s*(?:<v\s*\/>|<v><\/v>|<\/c>)/g;

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) {
    count++;
    if (count >= MAX_REPORTED_COUNT) break;
  }
  pattern.lastIndex = 0;
  return count;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Worksheet part path → sheet name, from workbook.xml and its rels. */
function sheetNamesByPart(
  workbookXml: string | undefined,
  relsXml: string | undefined,
): Map<string, string> {
  const byPart = new Map<string, string>();
  if (!workbookXml || !relsXml) return byPart;
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(match[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1];
    if (id && target) {
      targets.set(
        id,
        `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`,
      );
    }
  }
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(match[0])?.[1];
    const relId = /\br:id="([^"]*)"/.exec(match[0])?.[1];
    const part = relId ? targets.get(relId) : undefined;
    if (name && part) byPart.set(part, unescapeXml(name));
  }
  return byPart;
}

function scanXlsxXml(bytes: Uint8Array): ContentScan {
  const entries: { name: string; size: number }[] = [];
  let total = 0;
  unzipSync(bytes, {
    filter: (file) => {
      entries.push({ name: file.name, size: file.originalSize });
      total += file.originalSize;
      return false;
    },
  });
  if (total > MAX_UNCOMPRESSED_BYTES || entries.length > MAX_ZIP_ENTRIES) {
    throw new InspectionTooLargeError();
  }

  // One part at a time, so only the part being scanned is held inflated.
  const readPart = (name: string, encoding: BufferEncoding) => {
    const part = unzipSync(bytes, { filter: (file) => file.name === name })[
      name
    ];
    return part
      ? Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString(
          encoding,
        )
      : undefined;
  };

  const names = sheetNamesByPart(
    readPart('xl/workbook.xml', 'utf8'),
    readPart('xl/_rels/workbook.xml.rels', 'utf8'),
  );

  const emailHits: ContentScan['emailHits'] = [];
  const formulasWithoutValues: ContentScan['formulasWithoutValues'] = [];
  for (const entry of entries) {
    const isSheet = /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name);
    const isStrings = entry.name === 'xl/sharedStrings.xml';
    if (!isSheet && !isStrings) continue;
    // latin1: the patterns are ASCII, and it decodes ~56 MB without the
    // UTF-8 validation cost.
    const text = readPart(entry.name, 'latin1');
    if (!text) continue;
    const where = isStrings
      ? 'shared strings'
      : (names.get(entry.name) ?? entry.name);
    const emails = countEmails(text);
    if (emails > 0) emailHits.push({ where, count: emails });
    if (isSheet) {
      const formulas = countMatches(text, FORMULA_WITHOUT_VALUE);
      if (formulas > 0)
        formulasWithoutValues.push({ sheet: where, count: formulas });
    }
  }
  return { emailHits, formulasWithoutValues };
}

/** Full-content scan of a workbook. Also enforces the inflate limit. */
export function scanXlsx(buffer: Buffer): ContentScan {
  return scanXlsxXml(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
}

export function scanCsv(buffer: Buffer): ContentScan {
  const emails = countEmails(buffer.toString('utf8'));
  return {
    emailHits: emails > 0 ? [{ where: 'csv', count: emails }] : [],
    formulasWithoutValues: [],
  };
}

/**
 * Reads every text column of a parquet file in full. A file with more rows
 * than the scan limit cannot be vouched for and is refused.
 */
export async function scanParquet(buffer: Buffer): Promise<ContentScan> {
  const shape = parquetShape(buffer);
  if (shape.rowCount > MAX_PARQUET_SCAN_ROWS) {
    throw new InspectionTooLargeError();
  }
  const rows = await readParquetColumns(buffer, shape.stringColumns);
  const hits = new Map<string, number>();
  for (const row of rows) {
    for (const column of shape.stringColumns) {
      const value = row[column];
      if (typeof value !== 'string' || !value.includes('@')) continue;
      const count = countEmails(value);
      if (count > 0) hits.set(column, (hits.get(column) ?? 0) + count);
    }
  }
  return {
    emailHits: [...hits].map(([where, count]) => ({
      where,
      count: Math.min(count, MAX_REPORTED_COUNT),
    })),
    formulasWithoutValues: [],
  };
}
