import {
  enforceMissingFieldPolicy,
  missingRequiredCells,
} from '@/lib/services/workflows/data/requiredFields';
import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const columns: DataColumn[] = [
  { id: 'name', name: 'Name', type: 'text', required: true },
  { id: 'age', name: 'Age', type: 'number', required: true },
  { id: 'notes', name: 'Notes', type: 'text' },
];

describe('missingRequiredCells', () => {
  it('flags empty string, null, and undefined in required columns only', () => {
    const rows = [
      { [ROW_ID_KEY]: 'a', name: 'Amina', age: 34, notes: null },
      { [ROW_ID_KEY]: 'b', name: '', age: null },
      { [ROW_ID_KEY]: 'c', name: 'Karim' },
    ];
    const flagged = missingRequiredCells(columns, rows);
    expect(flagged.has('a')).toBe(false);
    expect([...flagged.get('b')!]).toEqual(['name', 'age']);
    expect([...flagged.get('c')!]).toEqual(['age']);
  });

  it('returns an empty map when nothing is required', () => {
    const relaxed = columns.map((c) => ({ ...c, required: false }));
    const flagged = missingRequiredCells(relaxed, [
      { [ROW_ID_KEY]: 'a', name: null },
    ]);
    expect(flagged.size).toBe(0);
  });

  it('skips rows without a rid (pre-backfill)', () => {
    const flagged = missingRequiredCells(columns, [{ name: '' }]);
    expect(flagged.size).toBe(0);
  });
});

describe('enforceMissingFieldPolicy', () => {
  const newRows = [
    { name: 'Amina', age: 34 },
    { name: '', age: 40 },
    { name: 'Karim', age: null },
  ];

  it('strict drops offending rows and names the missing fields', () => {
    const result = enforceMissingFieldPolicy(columns, newRows, 'strict');
    expect(result.rows).toEqual([{ name: 'Amina', age: 34 }]);
    expect(result.dropped).toBe(2);
    expect(result.droppedFields.sort()).toEqual(['Age', 'Name']);
  });

  it('flag and lenient pass everything through untouched', () => {
    for (const policy of ['flag', 'lenient'] as const) {
      const result = enforceMissingFieldPolicy(columns, newRows, policy);
      expect(result.rows).toBe(newRows);
      expect(result.dropped).toBe(0);
      expect(result.droppedFields).toEqual([]);
    }
  });

  it('strict without required columns is a pass-through', () => {
    const relaxed: DataColumn[] = [{ id: 'name', name: 'Name', type: 'text' }];
    const result = enforceMissingFieldPolicy(relaxed, newRows, 'strict');
    expect(result.rows).toBe(newRows);
    expect(result.dropped).toBe(0);
  });
});
