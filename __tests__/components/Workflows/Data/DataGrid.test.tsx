import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

import { DataGrid } from '@/components/Workflows/Data/DataGrid';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// jsdom has no layout, so the real virtualizer renders zero rows;
// render every row instead (tiny fixtures).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 33,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 33,
      })),
  }),
}));

const columns: DataColumn[] = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'cases', name: 'Cases', type: 'number' },
];

const rows = [
  { [ROW_ID_KEY]: 'a', name: 'North', cases: 30 },
  { [ROW_ID_KEY]: 'b', name: 'South', cases: 10 },
  { [ROW_ID_KEY]: 'c', name: 'East', cases: 20 },
];

function renderGrid(
  overrides: Partial<React.ComponentProps<typeof DataGrid>> = {},
) {
  const onToggleRow = vi.fn();
  render(
    <DataGrid
      columns={columns}
      rows={rows}
      selectedRows={new Set<string>()}
      onToggleRow={onToggleRow}
      onToggleAll={vi.fn()}
      {...overrides}
    />,
  );
  return { onToggleRow };
}

describe('DataGrid row identity', () => {
  it('toggles rows by stable rid', () => {
    const { onToggleRow } = renderGrid();
    // First data row checkbox (index 0 is the select-all header checkbox).
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    expect(onToggleRow).toHaveBeenCalledWith('a');
  });

  it('selection follows the row through sorting', () => {
    const { onToggleRow } = renderGrid();
    // Numeric columns sort DESC first in TanStack: a(30), c(20), b(10);
    // a second click flips to ascending.
    fireEvent.click(screen.getByRole('button', { name: /Cases/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cases/ }));
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    expect(onToggleRow).toHaveBeenCalledWith('b');
  });

  it('highlights selected rows by rid regardless of display order', () => {
    renderGrid({ selectedRows: new Set(['c']) });
    const checkboxes = screen.getAllByRole('checkbox');
    // Row 'c' is the third data row in unsorted order.
    expect(checkboxes[3]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it('footer reports filtered visibility when totals differ', () => {
    // The setup's next-intl mock falls back to raw keys for messages it
    // doesn't define — the switch from rowCount to showingRows is the
    // behavior under test.
    renderGrid({ totalRowCount: 10 });
    expect(screen.getByText('data.showingRows')).toBeInTheDocument();
    expect(screen.queryByText('data.rowCount')).not.toBeInTheDocument();
  });
});

describe('DataGrid cell flags', () => {
  it('marks missing-required (red) and pending-edit (amber) cells', () => {
    const cellFlags = new Map([
      ['a', new Map([['name', 'missing' as const]])],
      ['b', new Map([['cases', 'pending' as const]])],
    ]);
    renderGrid({ cellFlags });
    expect(screen.getByTitle('data.flagMissingRequired')).toBeInTheDocument();
    expect(screen.getByTitle('data.flagPendingEdit')).toBeInTheDocument();
  });

  it('shows the required marker on required column headers', () => {
    renderGrid({
      columns: [
        { id: 'name', name: 'Name', type: 'text', required: true },
        { id: 'cases', name: 'Cases', type: 'number' },
      ],
      profiles: new Map([
        ['name', { columnId: 'name', total: 3, missing: 0, distinct: 3 }],
      ]),
    });
    expect(screen.getByTitle('data.requiredColumn')).toBeInTheDocument();
  });
});
