import { mergeScopedResult } from '@/lib/services/workflows/data/scopedMerge';
import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const columns: DataColumn[] = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'cases', name: 'Cases', type: 'number' },
];

const rows = [
  { [ROW_ID_KEY]: 'a', name: 'North', cases: 10 },
  { [ROW_ID_KEY]: 'b', name: 'South', cases: 20 },
  { [ROW_ID_KEY]: 'c', name: 'East', cases: 30 },
];

describe('mergeScopedResult', () => {
  it('rebuilds scoped rows positionally, preserving their rids', () => {
    const merged = mergeScopedResult({
      rows,
      scopedRids: new Set(['a', 'c']),
      columns,
      resultColumns: columns,
      resultRows: [
        { name: 'NORTH', cases: 10 },
        { name: 'EAST', cases: 30 },
      ],
    });
    expect(merged).toEqual([
      { [ROW_ID_KEY]: 'a', name: 'NORTH', cases: 10 },
      { [ROW_ID_KEY]: 'b', name: 'South', cases: 20 },
      { [ROW_ID_KEY]: 'c', name: 'EAST', cases: 30 },
    ]);
    // Out-of-scope rows keep identity when no columns were added.
    expect(merged[1]).toBe(rows[1]);
  });

  it('null-fills new columns on out-of-scope rows', () => {
    const resultColumns: DataColumn[] = [
      ...columns,
      { id: 'rate', name: 'Rate', type: 'number' },
    ];
    const merged = mergeScopedResult({
      rows,
      scopedRids: new Set(['b']),
      columns,
      resultColumns,
      resultRows: [{ name: 'South', cases: 20, rate: 0.5 }],
    });
    expect(merged[1]).toEqual({
      [ROW_ID_KEY]: 'b',
      name: 'South',
      cases: 20,
      rate: 0.5,
    });
    expect(merged[0].rate).toBeNull();
    expect(merged[2].rate).toBeNull();
  });
});
