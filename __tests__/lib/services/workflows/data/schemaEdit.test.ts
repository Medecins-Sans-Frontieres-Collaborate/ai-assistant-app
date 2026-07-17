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
