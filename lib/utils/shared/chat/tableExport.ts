/**
 * Serializers that turn a rendered markdown table (as a row/cell string
 * matrix, first row = header — GFM tables always have one) into downloadable
 * payloads (CSV / TSV / Markdown / HTML). `extractTableRows` reads the matrix
 * out of a rendered `<table>` element client-side; the serializers are pure.
 * Used by `MarkdownTable` via the existing `downloadFile()` /
 * `useDocumentExport()` helpers.
 */

export type TableRows = string[][];

export function extractTableRows(table: HTMLTableElement): TableRows {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => (cell.textContent ?? '').trim()),
  );
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function tableRowsToCsv(rows: TableRows): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

export function tableRowsToTsv(rows: TableRows): string {
  // Tabs/newlines inside a cell would shift columns on paste; collapse them.
  return rows
    .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, ' ')).join('\t'))
    .join('\n');
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function tableRowsToMarkdown(rows: TableRows): string {
  if (rows.length === 0) return '';
  // Rows can be ragged when the source HTML used colspan; pad every line to
  // the widest row so GFM parses the result as a table.
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return '';
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => markdownCell(row[i] ?? '')).join(' | ')} |`;
  const [header, ...body] = rows;
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [line(header), separator, ...body.map(line)].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline border styles so Word shows gridlines when the fragment goes through
// the html-to-docx conversion endpoint.
const CELL_STYLE = 'border: 1px solid #999999; padding: 4px 8px;';

export function tableRowsToHtml(rows: TableRows): string {
  if (rows.length === 0) return '';
  const cells = (row: string[], tag: 'th' | 'td') =>
    row
      .map(
        (cell) => `<${tag} style="${CELL_STYLE}">${escapeHtml(cell)}</${tag}>`,
      )
      .join('');
  const [header, ...body] = rows;
  const head = `<thead><tr>${cells(header, 'th')}</tr></thead>`;
  const bodyHtml =
    body.length > 0
      ? `<tbody>${body.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody>`
      : '';
  return `<table style="border-collapse: collapse;">${head}${bodyHtml}</table>`;
}
