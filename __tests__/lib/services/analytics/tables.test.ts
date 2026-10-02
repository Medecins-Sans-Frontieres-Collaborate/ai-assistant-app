import { extractTables, toCell } from '@/lib/services/analytics/extract';
import { gridToTable, kindOfColumn } from '@/lib/services/analytics/tables';

import { CLEAN_PARQUET_BASE64 } from './parquetFixtures';
import { Row, usageSheets, workbook } from './workbooks';

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

function table(grid: Row[], overrides = {}) {
  return gridToTable({
    name: 'Sheet',
    grid,
    sourceRows: grid.length,
    freeform: false,
    declaredFields: [],
    maxRows: 5000,
    ...overrides,
  });
}

describe('kindOfColumn', () => {
  it('calls a column text as soon as one value reads as words', () => {
    expect(kindOfColumn([1, 2, 'n/a'])).toBe('text');
  });

  it('recognises numbers, dates, flags and emptiness', () => {
    expect(kindOfColumn([1, '2.5', null, '40%'])).toBe('number');
    expect(kindOfColumn(['2026-07-01', '2026-07-02T08:00:00.000Z'])).toBe(
      'date',
    );
    expect(kindOfColumn([true, 'no', null])).toBe('boolean');
    expect(kindOfColumn([null, '', null])).toBe('empty');
  });
});

describe('gridToTable', () => {
  it('skips title rows, names blank and repeated headers, and pads short rows', () => {
    const result = table([
      ['Rebilling — 2026-07'],
      [],
      ['Section', null, 'Billed', 'Billed'],
      ['OC Amsterdam', 'x', 4209.76],
      ['OC Geneva', 'y', 3180.27, 1],
    ]);
    expect(result.layout).toBe('table');
    expect(result.columns.map((column) => column.name)).toEqual([
      'Section',
      'Column B',
      'Billed',
      'Billed (2)',
    ]);
    expect(result.rows[0]).toEqual(['OC Amsterdam', 'x', 4209.76, null]);
    expect(result.rowCount).toBe(2);
  });

  it('marks a table with a user-code column as row-level', () => {
    expect(
      table([
        ['UserId', 'total'],
        ['u-93d80e8bfd9b', 4],
      ]).rowLevel,
    ).toBe(true);
    expect(
      table([
        ['date', 'unique_users'],
        ['2026-07-01', 73],
      ]).rowLevel,
    ).toBe(false);
  });

  it('caps the rows it keeps and still reports the true count', () => {
    const grid: Row[] = [['Section', 'Billed']];
    for (let i = 0; i < 50; i++) grid.push([`S${i}`, i]);
    const result = table(grid, { maxRows: 10, sourceRows: 9001 });
    expect(result.rows).toHaveLength(10);
    expect(result.rowCount).toBe(9000);
    expect(result.truncated).toBe(true);
  });

  it('keeps a declared page as laid out, with the fields it was declared to hold', () => {
    const result = table([['Headline figures'], ['Requests', 1200]], {
      freeform: true,
      declaredFields: ['department'],
    });
    expect(result.layout).toBe('freeform');
    expect(result.columns.map((column) => column.name)).toEqual(['A', 'B']);
    expect(result.rows).toEqual([
      ['Headline figures', null],
      ['Requests', 1200],
    ]);
    expect(result.declaredFields).toEqual(['department']);
  });

  it('files a page it could not read as a table under the catch-all field', () => {
    const result = table([
      ['Requests', 1200],
      ['Active users', 181],
    ]);
    expect(result.layout).toBe('freeform');
    expect(result.declaredFields).toEqual(['other']);
  });

  it('takes column names from a schema without looking for a header', () => {
    const result = table(
      [
        [2024, 5],
        [2025, 7],
      ],
      { header: ['2024', 'count'], sourceRows: 2 },
    );
    expect(result.layout).toBe('table');
    expect(result.columns.map((column) => column.name)).toEqual([
      '2024',
      'count',
    ]);
    expect(result.rowCount).toBe(2);
  });
});

describe('toCell', () => {
  it('makes reader values JSON-safe', () => {
    expect(toCell(new Date('2026-07-01T00:00:00.000Z'))).toBe('2026-07-01');
    expect(toCell(new Date('2026-07-01T08:30:00.000Z'))).toBe(
      '2026-07-01T08:30:00.000Z',
    );
    expect(toCell(12n)).toBe(12);
    expect(toCell(2n ** 60n)).toBe((2n ** 60n).toString());
    expect(toCell(Number.NaN)).toBeNull();
    expect(toCell(undefined)).toBeNull();
    expect(toCell({ a: 1 })).toBe('{"a":1}');
  });
});

describe('extractTables', () => {
  it('reads a workbook sheet by sheet, capped, with the true row counts', async () => {
    const interactions: Row[] = [['UserId', 'ModelUsed', 'event_date']];
    for (let i = 0; i < 300; i++) {
      interactions.push(['u-93d80e8bfd9b', 'gpt-5.4', '2026-07-01']);
    }
    const tables = await extractTables(
      workbook(usageSheets({ Interactions: interactions })),
      'xlsx',
      { maxRows: 100 },
    );
    const table = tables.find((t) => t.name === 'Interactions')!;
    expect(table.rows).toHaveLength(100);
    expect(table.rowCount).toBe(300);
    expect(table.truncated).toBe(true);
    expect(tables.find((t) => t.name === 'Daily')!.truncated).toBe(false);
  });

  it('reads every row when asked, and only the sheet asked for', async () => {
    const tables = await extractTables(workbook(usageSheets()), 'xlsx', {
      maxRows: Number.POSITIVE_INFINITY,
      onlySheets: ['Users'],
    });
    expect(tables.map((t) => t.name)).toEqual(['Users']);
    expect(tables[0].rows).toHaveLength(2);
  });

  it('reads a date cell as the date it shows, whatever the server time zone', async () => {
    // 46204 is 1 July 2026 as a spreadsheet serial; written as a number with
    // a date format so the writer's own time-zone handling is not involved.
    const sheet = XLSX.utils.aoa_to_sheet([
      ['label', 'when'],
      ['first', 46204],
    ]);
    sheet['B2'] = { t: 'n', v: 46204, z: 'yyyy-mm-dd' } as XLSX.CellObject;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Dates');
    const [table] = await extractTables(
      XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      'xlsx',
      { maxRows: 10 },
    );
    expect(table.columns[1].kind).toBe('date');
    expect(table.rows[0][1]).toBe('2026-07-01');
  });

  it('gives CSV numbers and flags their type back, and keeps the header as text', async () => {
    const [table] = await extractTables(
      Buffer.from('Section,2026,active\nOC Geneva,3180.27,true\n,,\n'),
      'csv',
      { maxRows: 10 },
    );
    expect(table.columns.map((c) => [c.name, c.kind])).toEqual([
      ['Section', 'text'],
      ['2026', 'number'],
      ['active', 'boolean'],
    ]);
    expect(table.rows[0]).toEqual(['OC Geneva', 3180.27, true]);
  });

  it('reads parquet: schema names, typed values, capped rows', async () => {
    const [table] = await extractTables(
      Buffer.from(CLEAN_PARQUET_BASE64, 'base64'),
      'parquet',
      { maxRows: 2 },
    );
    expect(table.name).toBe('data');
    expect(table.columns.map((c) => c.name)).toEqual([
      'UserId',
      'UserDepartment',
      'event_time',
      'interactions',
      'share',
      'streamed',
    ]);
    expect(table.rows).toHaveLength(2);
    expect(table.rowCount).toBe(3);
    expect(table.truncated).toBe(true);
    expect(table.rowLevel).toBe(true);
    expect(table.rows[0]).toEqual([
      'u-93d80e8bfd9b',
      'Logistics',
      '2026-07-01T08:30:00.000Z',
      12,
      0.5,
      true,
    ]);
    // Midnight timestamps read as plain dates.
    expect(table.rows[1][2]).toBe('2026-07-02');
  });

  it('throws on bytes that are not the format they claim', async () => {
    await expect(
      extractTables(Buffer.from('nope'), 'parquet', { maxRows: 10 }),
    ).rejects.toThrow();
  });
});
