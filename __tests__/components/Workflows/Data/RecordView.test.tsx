import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

import { RecordView } from '@/components/Workflows/Data/RecordView';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const columns: DataColumn[] = [
  { id: 'name', name: 'Patient Name', type: 'text', required: true },
  { id: 'age', name: 'Age', type: 'number' },
  { id: 'vaccinated', name: 'Vaccinated', type: 'boolean' },
];

const rows = [
  { [ROW_ID_KEY]: 'a', name: 'Amina', age: 34, vaccinated: true },
  { [ROW_ID_KEY]: 'b', name: '', age: null, vaccinated: null },
];

describe('RecordView', () => {
  it('renders one record as labeled typed fields', () => {
    render(<RecordView columns={columns} rows={rows} onSetCell={vi.fn()} />);
    expect(screen.getByLabelText(/Patient Name/)).toHaveValue('Amina');
    expect(screen.getByLabelText(/Age/)).toHaveValue(34);
    expect(screen.getByLabelText(/Vaccinated/)).toHaveValue('true');
  });

  it('edits report the rid, column, and raw value', () => {
    const onSetCell = vi.fn();
    render(<RecordView columns={columns} rows={rows} onSetCell={onSetCell} />);
    fireEvent.change(screen.getByLabelText(/Patient Name/), {
      target: { value: 'Amina K.' },
    });
    expect(onSetCell).toHaveBeenCalledWith('a', 'name', 'Amina K.');
  });

  it('navigates between records and shows missing-required flags', () => {
    const flags = new Map([['b', new Map([['name', 'missing' as const]])]]);
    render(
      <RecordView
        columns={columns}
        rows={rows}
        cellFlags={flags}
        onSetCell={vi.fn()}
      />,
    );
    // Record 1 has no flag message.
    expect(screen.queryByText('flagMissingRequired')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'recordNext' }));
    expect(screen.getByLabelText(/Patient Name/)).toHaveValue('');
    expect(screen.getByText('flagMissingRequired')).toBeInTheDocument();
  });
});
