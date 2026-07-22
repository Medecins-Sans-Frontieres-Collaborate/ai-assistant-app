import {
  applyCellEdit,
  applyDeleteRow,
  applyQualityEdit,
} from '@/lib/services/workflows/data/qualityApplication';
import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn, DataQualityEdit } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const columns: DataColumn[] = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'cases', name: 'Cases', type: 'number' },
];

const rows = [
  { [ROW_ID_KEY]: '0', name: 'Male', cases: 10 },
  { [ROW_ID_KEY]: '1', name: 'M', cases: 12000 },
];

function cellEdit(overrides: Partial<DataQualityEdit>): DataQualityEdit {
  return {
    id: 'e1',
    criterion: 'consistency',
    kind: 'cell',
    rid: '1',
    columnId: 'name',
    before: 'M',
    after: 'Male',
    reason: 'variant',
    severity: 'minor',
    status: 'pending',
    ...overrides,
  };
}

describe('applyCellEdit', () => {
  it('refuses edits targeting derived (formula) columns', () => {
    const derivedColumns: DataColumn[] = [
      ...columns,
      { id: 'double', name: 'Double', type: 'number', formula: '[cases] * 2' },
    ];
    const result = applyCellEdit(
      [{ [ROW_ID_KEY]: '1', name: 'M', cases: 5, double: 10 }],
      derivedColumns,
      cellEdit({ columnId: 'double', before: '10', after: '12' }),
    );
    expect(result.applied).toBe(false);
  });

  it('applies when the cell still matches and coerces to the column type', () => {
    const text = applyCellEdit(rows, columns, cellEdit({}));
    expect(text.applied).toBe(true);
    expect(text.rows[1].name).toBe('Male');
    // Untouched rows keep identity.
    expect(text.rows[0]).toBe(rows[0]);

    const numeric = applyCellEdit(
      rows,
      columns,
      cellEdit({ columnId: 'cases', before: '12000', after: '1200' }),
    );
    expect(numeric.applied).toBe(true);
    expect(numeric.rows[1].cases).toBe(1200);
  });

  it('degrades to unapplicable when the value drifted since assessment', () => {
    const result = applyCellEdit(rows, columns, cellEdit({ before: 'Hombre' }));
    expect(result.applied).toBe(false);
    expect(result.rows).toBe(rows);
  });

  it('is unapplicable for a missing rid or unknown column', () => {
    expect(applyCellEdit(rows, columns, cellEdit({ rid: 'zz' })).applied).toBe(
      false,
    );
    expect(
      applyCellEdit(rows, columns, cellEdit({ columnId: 'nope' })).applied,
    ).toBe(false);
  });

  it("clears the cell when after is ''", () => {
    const result = applyCellEdit(rows, columns, cellEdit({ after: '' }));
    expect(result.applied).toBe(true);
    expect(result.rows[1].name).toBeNull();
  });
});

describe('applyDeleteRow', () => {
  const deleteEdit = cellEdit({
    kind: 'deleteRow',
    columnId: undefined,
    rid: '0',
    before: 'Male, 10',
    after: '',
  });

  it('removes the row by rid', () => {
    const result = applyDeleteRow(rows, deleteEdit);
    expect(result.applied).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][ROW_ID_KEY]).toBe('1');
  });

  it('is unapplicable when the row is already gone', () => {
    const result = applyDeleteRow(rows, { ...deleteEdit, rid: 'zz' });
    expect(result.applied).toBe(false);
    expect(result.rows).toBe(rows);
  });
});

describe('applyQualityEdit', () => {
  it('routes by kind', () => {
    expect(applyQualityEdit(rows, columns, cellEdit({})).rows[1].name).toBe(
      'Male',
    );
    expect(
      applyQualityEdit(
        rows,
        columns,
        cellEdit({ kind: 'deleteRow', rid: '0', before: '', after: '' }),
      ).rows,
    ).toHaveLength(1);
  });
});
