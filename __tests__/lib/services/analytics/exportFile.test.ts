import {
  ExportTooLargeError,
  MAX_XLSX_EXPORT_CELLS,
  exportFileName,
  neutralizeCsvCell,
  tableToCsv,
  tablesToXlsx,
} from '@/lib/services/analytics/exportFile';
import { TableView } from '@/lib/services/analytics/previewModel';
import { Cell } from '@/lib/services/analytics/tables';

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

function view(
  name: string,
  columns: string[],
  rows: Cell[][],
  layout: TableView['layout'] = 'table',
): TableView {
  return {
    name,
    layout,
    rowCount: rows.length,
    shownRows: rows.length,
    truncated: false,
    rowLevel: false,
    withheld: null,
    columns: columns.map((column) => ({
      name: column,
      kind: 'text',
      field: null,
      hiddenFromUsers: false,
    })),
    rows,
  };
}

describe('neutralizeCsvCell', () => {
  it('defuses text a spreadsheet would run as a formula', () => {
    expect(neutralizeCsvCell('=HYPERLINK("http://x","y")')).toBe(
      '\'=HYPERLINK("http://x","y")',
    );
    expect(neutralizeCsvCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(neutralizeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeCsvCell('-1+1|x')).toBe("'-1+1|x");
  });

  it('leaves ordinary values alone, negative numbers included', () => {
    expect(neutralizeCsvCell('Logistics')).toBe('Logistics');
    expect(neutralizeCsvCell('-12.5')).toBe('-12.5');
    expect(neutralizeCsvCell(-12.5)).toBe(-12.5);
    expect(neutralizeCsvCell(null)).toBeNull();
    // A bullet-prefixed job title from the real data is not a formula.
    expect(neutralizeCsvCell('• Référent technique')).toBe(
      '• Référent technique',
    );
  });
});

describe('tableToCsv', () => {
  it('writes a BOM, the header, quoted values and defused cells', () => {
    const csv = tableToCsv(
      view(
        'Users',
        ['UserId', 'UserDepartment'],
        [
          ['u-93d80e8bfd9b', 'Logistics, Supply'],
          ['u-f7d440cec18d', '=1+1'],
          ['u-07e21ccbf0a6', null],
        ],
      ),
    );
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.subarray(3).toString('utf8')).toBe(
      'UserId,UserDepartment\r\n' +
        'u-93d80e8bfd9b,"Logistics, Supply"\r\n' +
        "u-f7d440cec18d,'=1+1\r\n" +
        'u-07e21ccbf0a6,',
    );
  });
});

describe('tablesToXlsx', () => {
  it('writes one sheet per table, values only, and a page as it was laid out', () => {
    const buffer = tablesToXlsx([
      view('Users', ['UserId', 'total'], [['u-93d80e8bfd9b', 4]]),
      view('Summary', ['A', 'B'], [['Requests', 12]], 'freeform'),
    ]);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    expect(workbook.SheetNames).toEqual(['Users', 'Summary']);
    expect(
      XLSX.utils.sheet_to_json(workbook.Sheets.Users, { header: 1 }),
    ).toEqual([
      ['UserId', 'total'],
      ['u-93d80e8bfd9b', 4],
    ]);
    // No header row is invented for a laid-out page.
    expect(
      XLSX.utils.sheet_to_json(workbook.Sheets.Summary, { header: 1 }),
    ).toEqual([['Requests', 12]]);
  });

  it('writes a formula-looking string as a string, not a formula', () => {
    const buffer = tablesToXlsx([view('T', ['note'], [['=1+1']])]);
    const cell = XLSX.read(buffer, { type: 'buffer', cellFormula: true }).Sheets
      .T.A2;
    expect(cell.t).toBe('s');
    expect(cell.f).toBeUndefined();
  });

  it('makes sheet names Excel will accept, and unique', () => {
    const buffer = tablesToXlsx([
      view('Usage: detail / all [x]', ['a'], [[1]]),
      view('Usage: detail / all [x]', ['a'], [[1]]),
    ]);
    const names = XLSX.read(buffer, { type: 'buffer' }).SheetNames;
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name).not.toMatch(/[\\/?*[\]:]/);
    }
  });

  it('refuses a workbook over the cell limit before building it', () => {
    const rows = Array.from({ length: MAX_XLSX_EXPORT_CELLS / 2 }, () => [
      'a',
      'b',
    ]);
    expect(() => tablesToXlsx([view('Big', ['a', 'b'], rows)])).toThrow(
      ExportTooLargeError,
    );
  });
});

describe('exportFileName', () => {
  it('derives a name from the delivered file and the table', () => {
    expect(
      exportFileName(
        'ocba_report_2026-07-01_to_2026-07-31.xlsx',
        'csv',
        'Users',
      ),
    ).toBe('ocba_report_2026-07-01_to_2026-07-31_Users.csv');
    expect(exportFileName('2026-09-26.parquet', 'xlsx')).toBe(
      '2026-09-26_export.xlsx',
    );
    expect(exportFileName('report.xlsx', 'csv', 'Usage detail / all')).toBe(
      'report_Usage_detail_all.csv',
    );
  });
});
