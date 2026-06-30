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
