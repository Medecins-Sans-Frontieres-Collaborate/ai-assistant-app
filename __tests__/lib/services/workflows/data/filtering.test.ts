import {
  ColumnFilter,
  applyFilters,
  defaultFilterKind,
  isFilterActive,
  rowMatches,
} from '@/lib/services/workflows/data/filtering';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

describe('rowMatches', () => {
  it('text filter is case-insensitive contains', () => {
    const filter: ColumnFilter = { columnId: 't', kind: 'text', query: 'Al' };
    expect(rowMatches({ t: 'Kabul – Malalai' }, filter)).toBe(true);
    expect(rowMatches({ t: 'Bogotá' }, filter)).toBe(false);
    expect(rowMatches({ t: null }, filter)).toBe(false);
  });

  it('range filter supports open ends and excludes non-numbers', () => {
    expect(rowMatches({ n: 5 }, { columnId: 'n', kind: 'range', min: 3 })).toBe(
      true,
    );
    expect(rowMatches({ n: 2 }, { columnId: 'n', kind: 'range', min: 3 })).toBe(
      false,
    );
    expect(rowMatches({ n: 2 }, { columnId: 'n', kind: 'range', max: 3 })).toBe(
      true,
    );
    expect(
      rowMatches({ n: 'x' }, { columnId: 'n', kind: 'range', min: 0 }),
    ).toBe(false);
  });

  it('dateRange compares ISO strings', () => {
    const filter: ColumnFilter = {
      columnId: 'd',
      kind: 'dateRange',
      min: '2026-01-01',
      max: '2026-06-30',
    };
    expect(rowMatches({ d: '2026-03-15' }, filter)).toBe(true);
    expect(rowMatches({ d: '2025-12-31' }, filter)).toBe(false);
    expect(rowMatches({ d: null }, filter)).toBe(false);
  });

  it('values filter matches formatted cells (booleans included)', () => {
    const filter: ColumnFilter = {
      columnId: 'b',
      kind: 'values',
      values: ['true'],
    };
    expect(rowMatches({ b: true }, filter)).toBe(true);
    expect(rowMatches({ b: false }, filter)).toBe(false);
  });
});

describe('applyFilters', () => {
  const rows = [
    { region: 'North', cases: 10 },
    { region: 'South', cases: 50 },
    { region: 'North', cases: 90 },
  ];

  it('ANDs filters across columns', () => {
    const result = applyFilters(rows, [
      { columnId: 'region', kind: 'values', values: ['North'] },
      { columnId: 'cases', kind: 'range', min: 20 },
    ]);
    expect(result).toEqual([{ region: 'North', cases: 90 }]);
  });

  it('ignores inactive filters and returns the input array when none apply', () => {
    const inactive: ColumnFilter[] = [
      { columnId: 'region', kind: 'text', query: '   ' },
      { columnId: 'cases', kind: 'range' },
    ];
    expect(inactive.some(isFilterActive)).toBe(false);
    expect(applyFilters(rows, inactive)).toBe(rows);
  });
});

describe('defaultFilterKind', () => {
  const text: DataColumn = { id: 't', name: 'T', type: 'text' };
  it('picks by type and cardinality', () => {
    expect(
      defaultFilterKind({ id: 'n', name: 'N', type: 'number' }, 5, 20),
    ).toBe('range');
    expect(defaultFilterKind({ id: 'd', name: 'D', type: 'date' }, 5, 20)).toBe(
      'dateRange',
    );
    expect(
      defaultFilterKind({ id: 'b', name: 'B', type: 'boolean' }, 2, 20),
    ).toBe('values');
    expect(defaultFilterKind(text, 5, 20)).toBe('values');
    expect(defaultFilterKind(text, 500, 20)).toBe('text');
    expect(defaultFilterKind(text, 0, 20)).toBe('text');
  });
});
