import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { SavedStructure } from '@/types/structure';
import { DataColumn } from '@/types/workflow';

import { SchemaEditor } from '@/components/Workflows/Data/SchemaEditor';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const columns: DataColumn[] = [
  { id: 'name', name: 'Name', type: 'text', required: true },
];

const structure = (
  overrides: Partial<SavedStructure> = {},
): SavedStructure => ({
  id: 's1',
  name: 'Invoices',
  fields: [
    { id: 'f1', name: 'vendor', type: 'text', required: true },
    { id: 'f2', name: 'total', type: 'number' },
  ],
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  useSettingsStore.setState({ savedStructures: [] });
});

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

  describe('saved structures', () => {
    it('disables the load button when the library is empty', () => {
      render(
        <SchemaEditor columns={columns} onApply={vi.fn()} onClose={vi.fn()} />,
      );
      expect(
        screen.getByRole('button', { name: /loadFromStructure/ }),
      ).toBeDisabled();
    });

    it('replaces the draft with the chosen structure', () => {
      useSettingsStore.setState({ savedStructures: [structure()] });
      const onApply = vi.fn();
      render(
        <SchemaEditor columns={columns} onApply={onApply} onClose={vi.fn()} />,
      );

      fireEvent.click(
        screen.getByRole('button', { name: /loadFromStructure/ }),
      );
      fireEvent.click(screen.getByRole('option', { name: /Invoices/ }));

      // Old column is gone; the structure's fields replace it, and required
      // carries across only where it was set.
      fireEvent.click(screen.getByRole('button', { name: 'schemaApply' }));
      expect(onApply).toHaveBeenCalledWith([
        { name: 'vendor', type: 'text', required: true },
        { name: 'total', type: 'number', required: false },
      ]);
    });

    it('warns when loading downgrades non-tabular field types', () => {
      useSettingsStore.setState({
        savedStructures: [
          structure({
            fields: [
              { id: 'f1', name: 'status', type: 'enum', enumValues: ['a'] },
              { id: 'f2', name: 'tags', type: 'list<text>' },
            ],
          }),
        ],
      });
      render(
        <SchemaEditor columns={columns} onApply={vi.fn()} onClose={vi.fn()} />,
      );

      fireEvent.click(
        screen.getByRole('button', { name: /loadFromStructure/ }),
      );
      fireEvent.click(screen.getByRole('option', { name: /Invoices/ }));

      expect(screen.getByText(/downgradedNotice/)).toBeInTheDocument();
    });

    it('saves the current draft as a structure', () => {
      render(
        <SchemaEditor columns={columns} onApply={vi.fn()} onClose={vi.fn()} />,
      );

      fireEvent.click(screen.getByRole('button', { name: /saveAsStructure/ }));
      fireEvent.change(screen.getByLabelText('namePlaceholder'), {
        target: { value: 'People' },
      });
      fireEvent.submit(
        screen.getByLabelText('namePlaceholder').closest('form')!,
      );

      const saved = useSettingsStore.getState().savedStructures;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        name: 'People',
        fields: [
          {
            id: 'name',
            name: 'name',
            label: 'Name',
            type: 'text',
            required: true,
          },
        ],
      });
      expect(screen.getByText(/savedToast/)).toBeInTheDocument();
    });

    it('reports derived columns as skipped when saving', () => {
      const withFormula: DataColumn[] = [
        { id: 'cases', name: 'Cases', type: 'number' },
        { id: 'pop', name: 'Pop', type: 'number' },
        {
          id: 'rate',
          name: 'Rate',
          type: 'number',
          formula: '[cases] / [pop]',
        },
      ];
      render(
        <SchemaEditor
          columns={withFormula}
          onApply={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /saveAsStructure/ }));
      fireEvent.change(screen.getByLabelText('namePlaceholder'), {
        target: { value: 'Rates' },
      });
      fireEvent.submit(
        screen.getByLabelText('namePlaceholder').closest('form')!,
      );

      const saved = useSettingsStore.getState().savedStructures;
      expect(saved[0].fields.map((f) => f.id)).toEqual(['cases', 'pop']);
      expect(screen.getByText(/skippedDerivedNotice/)).toBeInTheDocument();
    });
  });
});
