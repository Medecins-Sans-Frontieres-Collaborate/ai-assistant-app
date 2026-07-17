import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { DataColumn } from '@/types/workflow';

import { SchemaEditor } from '@/components/Workflows/Data/SchemaEditor';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const columns: DataColumn[] = [
  { id: 'name', name: 'Name', type: 'text', required: true },
];

describe('SchemaEditor', () => {
  it('drafts edits and applies them with ids preserved', () => {
    const onApply = vi.fn();
    render(
      <SchemaEditor columns={columns} onApply={onApply} onClose={vi.fn()} />,
    );
    const nameInput = screen.getByDisplayValue('Name');
    fireEvent.change(nameInput, { target: { value: 'Full name' } });
    fireEvent.click(screen.getByRole('button', { name: 'schemaApply' }));
    expect(onApply).toHaveBeenCalledWith([
      { id: 'name', name: 'Full name', type: 'text', required: true },
    ]);
  });

  it('adds and removes fields; apply disabled while a name is empty', () => {
    const onApply = vi.fn();
    render(
      <SchemaEditor columns={columns} onApply={onApply} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /schemaAddField/ }));
    const applyButton = screen.getByRole('button', {
      name: 'schemaApply',
    });
    expect(applyButton).toBeDisabled();

    const inputs = screen.getAllByLabelText('schemaFieldName');
    fireEvent.change(inputs[1], { target: { value: 'Region' } });
    expect(applyButton).toBeEnabled();
    fireEvent.click(applyButton);
    expect(onApply).toHaveBeenCalledWith([
      { id: 'name', name: 'Name', type: 'text', required: true },
      { name: 'Region', type: 'text', required: false },
    ]);
  });

  it('starts with one blank field when no columns exist (schema-first)', () => {
    render(<SchemaEditor columns={[]} onApply={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByLabelText('schemaFieldName')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'schemaApply' })).toBeDisabled();
  });
});
