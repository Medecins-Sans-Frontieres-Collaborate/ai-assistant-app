import {
  MAX_ROWS,
  ROW_ID_KEY,
  buildTable,
  carryRowIds,
  coerceCell,
  collectHeaders,
  deriveNextRowId,
  formatCell,
  inferColumnType,
  jsonToRawRows,
  strideSample,
  stripRowIds,
  toColumnId,
  withRowIds,
} from '@/lib/services/workflows/data/tableUtils';

import { describe, expect, it } from 'vitest';

describe('toColumnId', () => {
  it('slugs header names', () => {
    expect(toColumnId('Cases per 1,000', 0)).toBe('cases_per_1_000');
  });
  it('falls back to positional ids', () => {
    expect(toColumnId('   ', 2)).toBe('col_3');
  });
});

describe('inferColumnType', () => {
  it('detects numbers', () => {
    expect(inferColumnType([1, '2', '3,000', null])).toBe('number');
  });
  it('detects dates', () => {
    expect(inferColumnType(['2026-01-01', '2026-02-15'])).toBe('date');
  });
  it('detects booleans', () => {
    expect(inferColumnType(['yes', 'no', 'true'])).toBe('boolean');
  });
  it('mixed columns become text', () => {
    expect(inferColumnType(['abc', 42, '2026-01-01'])).toBe('text');
  });
  it('empty columns default to text', () => {
    expect(inferColumnType([null, '', undefined])).toBe('text');
  });
});

describe('coerceCell', () => {
  it('coerces numbers with separators', () => {
    expect(coerceCell('3,000', 'number')).toBe(3000);
  });
  it('nulls unparseable numbers', () => {
    expect(coerceCell('n/a', 'number')).toBeNull();
  });
  it('coerces booleans', () => {
    expect(coerceCell('yes', 'boolean')).toBe(true);
    expect(coerceCell('N', 'boolean')).toBe(false);
  });
});

describe('buildTable', () => {
  it('builds typed columns and coerced rows', () => {
    const { columns, rows } = buildTable(
      ['Region', 'Cases'],
      [
        { Region: 'North', Cases: '1,200' },
        { Region: 'South', Cases: 800 },
      ],
    );
    expect(columns).toEqual([
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'cases', name: 'Cases', type: 'number' },
    ]);
    expect(rows[0]).toEqual({ region: 'North', cases: 1200 });
  });

  it('dedupes colliding column ids', () => {
    const { columns } = buildTable(
      ['Date', 'date'],
      [{ Date: '2026-01-01', date: '2026-01-02' }],
    );
    expect(columns[0].id).not.toBe(columns[1].id);
  });

  it('throws a marked error past the row cap', () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ n: i }));
    expect(() => buildTable(['n'], rows)).toThrow(/^ROW_CAP_EXCEEDED:/);
  });
});

describe('jsonToRawRows', () => {
  it('accepts arrays of objects', () => {
    expect(jsonToRawRows([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
  it('unwraps single-array wrappers', () => {
    expect(jsonToRawRows({ data: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
  it('wraps scalar items', () => {
    expect(jsonToRawRows([1, 2])).toEqual([{ value: 1 }, { value: 2 }]);
  });
  it('rejects non-array JSON', () => {
    expect(() => jsonToRawRows({ a: 1 })).toThrow();
  });
});

describe('collectHeaders', () => {
  it('unions keys preserving order', () => {
    expect(collectHeaders([{ a: 1 }, { b: 2, a: 3 }])).toEqual(['a', 'b']);
  });
});

describe('row identity helpers', () => {
  it('withRowIds assigns monotonic base36 ids and advances the counter', () => {
    const { rows, nextRowId } = withRowIds([{ a: 1 }, { a: 2 }], 35);
    expect(rows.map((r) => r[ROW_ID_KEY])).toEqual(['z', '10']);
    expect(nextRowId).toBe(37);
  });

  it('withRowIds preserves existing ids and returns the same array when nothing changes', () => {
    const input = [{ a: 1, [ROW_ID_KEY]: '5' }];
    const { rows, nextRowId } = withRowIds(input, 9);
    expect(rows).toBe(input);
    expect(nextRowId).toBe(9);
  });

  it('withRowIds fills gaps without touching existing ids', () => {
    const input = [{ a: 1, [ROW_ID_KEY]: '3' }, { a: 2 }];
    const { rows } = withRowIds(input, 10);
    expect(rows[0][ROW_ID_KEY]).toBe('3');
    expect(rows[1][ROW_ID_KEY]).toBe('a');
  });

  it('deriveNextRowId returns max parsed base36 + 1', () => {
    expect(
      deriveNextRowId([
        { [ROW_ID_KEY]: 'z' },
        { [ROW_ID_KEY]: '3' },
        { other: 1 },
      ]),
    ).toBe(36);
    expect(deriveNextRowId([{ a: 1 }])).toBe(0);
  });

  it('stripRowIds removes only the reserved key', () => {
    expect(stripRowIds([{ a: 1, [ROW_ID_KEY]: '0' }, { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it('carryRowIds copies rids positionally when the row count matches', () => {
    const prev = [
      { a: 1, [ROW_ID_KEY]: 'x' },
      { a: 2, [ROW_ID_KEY]: 'y' },
    ];
    const result = [{ b: 10 }, { b: 20 }];
    expect(carryRowIds(prev, result)).toEqual([
      { b: 10, [ROW_ID_KEY]: 'x' },
      { b: 20, [ROW_ID_KEY]: 'y' },
    ]);
  });

  it('carryRowIds leaves the result untouched when the row count differs', () => {
    const prev = [{ a: 1, [ROW_ID_KEY]: 'x' }];
    const result = [{ b: 10 }, { b: 20 }];
    expect(carryRowIds(prev, result)).toBe(result);
  });

  it('carryRowIds skips positions whose previous row had no rid', () => {
    const prev = [{ a: 1 }, { a: 2, [ROW_ID_KEY]: 'y' }];
    const result = [{ b: 10 }, { b: 20 }];
    expect(carryRowIds(prev, result)).toEqual([
      { b: 10 },
      { b: 20, [ROW_ID_KEY]: 'y' },
    ]);
  });
});

describe('currency-aware typing', () => {
  it('coerceCell parses currency-tagged and style-aware numbers', () => {
    expect(coerceCell('$25', 'number')).toBe(25);
    expect(coerceCell('1.234,56', 'number', { numberStyle: 'eu' })).toBe(
      1234.56,
    );
    expect(coerceCell('abc', 'number')).toBeNull();
  });

  it('buildTable types a partially $-tagged column as number with format', () => {
    const { columns, rows } = buildTable(
      ['Product', 'Cost'],
      [
        { Product: 'A', Cost: '25' },
        { Product: 'B', Cost: '$3.77' },
      ],
    );
    expect(columns[1]).toMatchObject({
      type: 'number',
      format: { currency: '$', numberStyle: 'us' },
    });
    expect(rows.map((r) => r.cost)).toEqual([25, 3.77]);
  });

  it('buildTable keeps mixed-currency columns as text', () => {
    const { columns, rows } = buildTable(
      ['Cost'],
      [{ Cost: '$5' }, { Cost: '€5' }],
    );
    expect(columns[0].type).toBe('text');
    expect(rows.map((r) => r.cost)).toEqual(['$5', '€5']);
  });
});

describe('formatCell', () => {
  it('renders null/undefined as empty and booleans as true/false', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
    expect(formatCell(true)).toBe('true');
    expect(formatCell(false)).toBe('false');
    expect(formatCell(3.5)).toBe('3.5');
  });

  it('round-trips with coerceCell for typed cells', () => {
    expect(coerceCell(formatCell(42), 'number')).toBe(42);
    expect(coerceCell(formatCell(true), 'boolean')).toBe(true);
    expect(coerceCell(formatCell('x'), 'text')).toBe('x');
  });
});

describe('strideSample', () => {
  it('returns the input untouched when it fits', () => {
    const items = [1, 2, 3];
    expect(strideSample(items, 5)).toBe(items);
  });

  it('keeps the head in full and samples the rest deterministically', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const sampled = strideSample(items, 300);
    expect(sampled).toHaveLength(300);
    expect(sampled.slice(0, 100)).toEqual(items.slice(0, 100));
    expect(strideSample(items, 300)).toEqual(sampled);
    expect(new Set(sampled).size).toBe(300);
  });
});
