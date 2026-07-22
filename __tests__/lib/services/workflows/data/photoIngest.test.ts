import {
  PhotoInferResult,
  photoInferToTable,
} from '@/lib/services/workflows/data/photoIngest';
import { photoInferResponseSchema } from '@/lib/services/workflows/data/photoSchema';

import { describe, expect, it } from 'vitest';

const inferResult: PhotoInferResult = {
  kind: 'record',
  columns: [
    { name: 'Patient Name', type: 'text', required: true },
    { name: 'Age', type: 'number', required: false },
    { name: 'Vaccinated?', type: 'boolean', required: false },
    { name: 'Visit Date', type: 'date', required: false },
  ],
  rows: [{ values: ['Amina K.', '34', 'true', '2026-06-01'] }],
  notes: '',
};

describe('photoInferToTable', () => {
  it('slugs names to unique ids and coerces values per type', () => {
    const { columns, rows } = photoInferToTable(inferResult);
    expect(columns.map((c) => c.id)).toEqual([
      'patient_name',
      'age',
      'vaccinated',
      'visit_date',
    ]);
    expect(columns[0].required).toBe(true);
    expect(columns[1].required).toBeUndefined();
    expect(rows[0]).toEqual({
      patient_name: 'Amina K.',
      age: 34,
      vaccinated: true,
      visit_date: '2026-06-01',
    });
  });

  it('deduplicates slugged ids and null-fills empty/missing values', () => {
    const { columns, rows } = photoInferToTable({
      kind: 'table',
      columns: [
        { name: 'Date', type: 'date', required: false },
        { name: 'date', type: 'text', required: false },
      ],
      rows: [{ values: ['2026-01-01'] }],
      notes: 'second column empty',
    });
    expect(columns.map((c) => c.id)).toEqual(['date', 'date_2']);
    expect(rows[0]).toEqual({ date: '2026-01-01', date_2: null });
  });

  it('names blank columns positionally', () => {
    const { columns } = photoInferToTable({
      kind: 'table',
      columns: [{ name: '  ', type: 'text', required: false }],
      rows: [],
      notes: '',
    });
    expect(columns[0].name).toBe('Column 1');
  });
});

/** Recursively asserts strict-mode invariants on a json_schema node. */
function assertStrict(node: Record<string, unknown>, path = '$'): void {
  if (node.type === 'object') {
    expect(node.additionalProperties, `${path}.additionalProperties`).toBe(
      false,
    );
    const properties = node.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(node.required, `${path}.required`).toEqual(
      expect.arrayContaining(Object.keys(properties)),
    );
    expect((node.required as string[]).length).toBe(
      Object.keys(properties).length,
    );
    for (const [key, child] of Object.entries(properties)) {
      assertStrict(child, `${path}.${key}`);
    }
  }
  if (node.type === 'array') {
    assertStrict(node.items as Record<string, unknown>, `${path}[]`);
  }
}

describe('photoInferResponseSchema', () => {
  it('satisfies strict-mode invariants recursively', () => {
    assertStrict(photoInferResponseSchema());
  });

  it('constrains kind and column types', () => {
    const schema = photoInferResponseSchema();
    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.kind.enum).toEqual(['record', 'table']);
    const columnItems = (
      properties.columns as {
        items: { properties: Record<string, { enum?: string[] }> };
      }
    ).items;
    expect(columnItems.properties.type.enum).toEqual([
      'text',
      'number',
      'date',
      'boolean',
    ]);
  });
});
