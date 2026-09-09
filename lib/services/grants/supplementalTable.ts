/**
 * Shared reader for supplemental CSV/XLSX files.
 *
 * Mirrors the loader used in the enrich stage: reads bytes via Node fs and
 * hands xlsx a buffer (XLSX.readFile fails inside the Next.js/Turbopack server
 * bundle), takes the header from the `skiprows` row (physical-row offset,
 * blank rows preserved), and trims every header name so trailing/embedded
 * spaces still match configured column names.
 */
import { readFileSync } from 'fs';
import * as XLSX from 'xlsx';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TableRow = Record<string, any>;

/** Lowercase, drop punctuation, collapse whitespace. */
function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Drop a trailing plural "s" from the final word ("project codes" → "project code"). */
function singularize(value: string): string {
  return value.replace(/s$/, '');
}

/**
 * Resolve which header in a supplemental table corresponds to a configured
 * column name.
 *
 * @param headers  Header names present in the table, in column order.
 * @param configured  The column name declared in the OC config.
 * @param aliases  Acceptable alternative names, most-preferred first.
 * @returns The matching header, or null when no tier matches.
 */
export function resolveColumn(
  headers: string[],
  configured: string,
  aliases: string[] = [],
): string | null {
  // 1. Exact match — preserves the previous behavior verbatim.
  const exact = headers.find((h) => h === configured);
  if (exact) return exact;

  const norm = new Map<string, string>();
  for (const h of headers)
    if (!norm.has(normalizeHeader(h))) norm.set(normalizeHeader(h), h);

  // 2. Normalized match against the configured name.
  const configuredNorm = normalizeHeader(configured);
  if (norm.has(configuredNorm)) return norm.get(configuredNorm)!;

  // 3. Normalized match against an alias, most-preferred first.
  for (const alias of aliases) {
    const hit = norm.get(normalizeHeader(alias));
    if (hit) return hit;
  }

  // 4. Singular/plural-insensitive match against the configured name or aliases.
  const singularNorm = new Map<string, string>();
  for (const [n, h] of norm)
    if (!singularNorm.has(singularize(n))) singularNorm.set(singularize(n), h);
  for (const candidate of [configuredNorm, ...aliases.map(normalizeHeader)]) {
    const hit = singularNorm.get(singularize(candidate));
    if (hit) return hit;
  }

  // 5. A shorter header that prefixes the configured name — catches
  //    "Project Name" for "Project Name in OCBA's Allocation Spreadsheet".
  //    Requires two or more words so a bare "Project" can never win.
  for (const [n, h] of norm) {
    if (n.split(' ').length < 2) continue;
    if (configuredNorm.startsWith(`${n} `)) return h;
  }

  // 6. A header that *begins* with the configured name or a multi-word alias —

  const prefixes = [configuredNorm, ...aliases.map(normalizeHeader)].filter(
    (p) => p.split(' ').length >= 2,
  );
  for (const [n, h] of norm) {
    if (n.includes('narrative')) continue;
    if (prefixes.some((p) => n.startsWith(`${p} `))) return h;
  }

  return null;
}

export function loadTable(path: string, skiprows: number = 0): TableRow[] {
  const buf = readFileSync(path);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
  });
  if (raw.length <= skiprows) return [];

  const header = (raw[skiprows] as unknown[]).map((h) =>
    String(h ?? '').trim(),
  );
  const rows: TableRow[] = [];
  for (let i = skiprows + 1; i < raw.length; i++) {
    const arr = raw[i] as unknown[];
    const obj: TableRow = {};
    for (let c = 0; c < header.length; c++) {
      if (header[c]) obj[header[c]] = arr[c] ?? '';
    }
    rows.push(obj);
  }
  return rows;
}
