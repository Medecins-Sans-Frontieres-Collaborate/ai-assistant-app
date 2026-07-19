import { applySchemaChanges } from '@/lib/services/workflows/data/schemaEdit';
import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const columns: DataColumn[] = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'age', name: 'Age', type: 'text' },
];
const rows = [
  { [ROW_ID_KEY]: 'a', name: 'Amina', age: '34' },
  { [ROW_ID_KEY]: 'b', name: 'Karim', age: 'unknown' },
];

describe('applySchemaChanges', () => {
  it('renames keep the id stable and rows untouched', () => {
    const result = applySchemaChanges(columns, rows, [
      { id: 'name', name: 'Full name', type: 'text', required: true },
      { id: 'age', name: 'Age', type: 'text', required: false },
    ]);
    expect(result.columns[0]).toEqual({
      id: 'name',
      name: 'Full name',
      type: 'text',
      required: true,
    });
    expect(result.rows).toBe(rows);
    expect(result.converted).toBe(0);
  });

  it('stores formulas as id-refs with number type forced', () => {
    const base: DataColumn[] = [
      { id: 'cases', name: 'Cases', type: 'number' },
      { id: 'pop', name: 'Population', type: 'number' },
    ];
    const result = applySchemaChanges(
      base,
      [{ [ROW_ID_KEY]: 'a', cases: 10, pop: 100 }],
      [
        { id: 'cases', name: 'Cases', type: 'number', required: false },
        { id: 'pop', name: 'Population', type: 'number', required: false },
        {
          name: 'Rate',
          type: 'text',
          required: true,
          formula: '[Cases] / [Population] * 1000',
        },
      ],
    );
    expect(result.columns[2]).toEqual({
      id: 'rate',
      name: 'Rate',
      type: 'number',
      formula: '[cases] / [pop] * 1000',
    });
    expect(result.converted).toBe(0);
  });

  it('resolves formula refs to columns added in the same draft', () => {
    const result = applySchemaChanges(
      [],
      [],
      [
        { name: 'Base', type: 'number', required: false },
        {
          name: 'Twice',
          type: 'number',
          required: false,
          formula: '[Base] * 2',
        },
      ],
    );
    expect(result.columns[1].formula).toBe('[base] * 2');
  });

  it('keeps a stored id-ref valid when the referenced column is renamed', () => {
    const base: DataColumn[] = [
      { id: 'pop', name: 'Population', type: 'number' },
      { id: 'rate', name: 'Rate', type: 'number', formula: '[pop] * 2' },
    ];
    const result = applySchemaChanges(
      base,
      [],
      [
        { id: 'pop', name: 'People', type: 'number', required: false },
        {
          id: 'rate',
          name: 'Rate',
          type: 'number',
          required: false,
          formula: '[Population] * 2',
        },
      ],
    );
    // The old name still resolves within the same draft session.
    expect(result.columns[1].formula).toBe('[pop] * 2');
  });

  it('strips raw cells when an existing column becomes derived', () => {
    const base: DataColumn[] = [
      { id: 'a', name: 'A', type: 'number' },
      { id: 'b', name: 'B', type: 'number' },
    ];
    const result = applySchemaChanges(
      base,
      [{ [ROW_ID_KEY]: 'r', a: 1, b: 99 }],
      [
        { id: 'a', name: 'A', type: 'number', required: false },
        {
          id: 'b',
          name: 'B',
          type: 'number',
          required: false,
          formula: '[A] + 1',
        },
      ],
    );
    expect('b' in result.rows[0]).toBe(false);
    expect(result.columns[1].formula).toBe('[a] + 1');
  });

  it('drops an unresolvable formula, leaving a plain number column', () => {
    const result = applySchemaChanges(
      [],
      [],
      [{ name: 'X', type: 'number', required: false, formula: '[Ghost] * 2' }],
    );
    expect(result.columns[0].formula).toBeUndefined();
    expect(result.columns[0].type).toBe('number');
  });

  it('retype to number detects currency format and converts "$" cells', () => {
    const costColumns: DataColumn[] = [
      { id: 'cost', name: 'Cost', type: 'text' },
    ];
    const costRows = [
      { [ROW_ID_KEY]: 'a', cost: '$25' },
      { [ROW_ID_KEY]: 'b', cost: '$3.77' },
      { [ROW_ID_KEY]: 'c', cost: '200' },
    ];
    const result = applySchemaChanges(costColumns, costRows, [
      { id: 'cost', name: 'Cost', type: 'number', required: false },
    ]);
    expect(result.converted).toBe(0);
    expect(result.rows.map((r) => r.cost)).toEqual([25, 3.77, 200]);
    expect(result.columns[0].format).toEqual({
      currency: '$',
      numberStyle: 'us',
    });
  });

  it('retype re-coerces cells and counts unconvertible ones', () => {
    const result = applySchemaChanges(columns, rows, [
      { id: 'name', name: 'Name', type: 'text', required: false },
      { id: 'age', name: 'Age', type: 'number', required: false },
    ]);
    expect(result.rows[0].age).toBe(34);
    expect(result.rows[1].age).toBeNull();
    expect(result.converted).toBe(1);
    // Rids ride along untouched.
    expect(result.rows.map((r) => r[ROW_ID_KEY])).toEqual(['a', 'b']);
  });

  it('new columns get unique slugged ids; deletes strip row keys', () => {
    const result = applySchemaChanges(columns, rows, [
      { id: 'name', name: 'Name', type: 'text', required: false },
      { name: 'Name', type: 'text', required: false }, // slug collides
      { name: 'Region', type: 'text', required: true },
    ]);
    expect(result.columns.map((c) => c.id)).toEqual([
      'name',
      'name_2',
      'region',
    ]);
    expect(result.columns[2].required).toBe(true);
    // 'age' deleted: key stripped from rows.
    expect('age' in result.rows[0]).toBe(false);
    expect(result.rows[0].name).toBe('Amina');
  });

  it('blank names become positional; empty draft yields no columns', () => {
    const named = applySchemaChanges(
      [],
      [],
      [{ name: '  ', type: 'text', required: false }],
    );
    expect(named.columns[0].name).toBe('Column 1');
    expect(applySchemaChanges(columns, rows, []).columns).toEqual([]);
  });
});
