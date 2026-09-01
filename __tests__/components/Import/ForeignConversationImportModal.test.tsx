import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ForeignImportDetection } from '@/lib/utils/app/export/foreignImport/types';

import { ForeignConversationImportModal } from '@/components/Import/ForeignConversationImportModal';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const detection: ForeignImportDetection = {
  source: 'chatgpt',
  skipped: 1,
  conversations: [
    {
      source: 'chatgpt',
      sourceId: 'a',
      title: 'Alpha thread',
      createdAt: '2024-01-01T00:00:00.000Z',
      turns: [{ role: 'user', text: 'x' }],
      droppedParts: 0,
    },
    {
      source: 'chatgpt',
      sourceId: 'b',
      title: 'Beta thread',
      turns: [
        { role: 'user', text: 'y' },
        { role: 'assistant', text: 'z' },
      ],
      droppedParts: 2,
    },
    {
      source: 'chatgpt',
      sourceId: 'c',
      title: 'Gamma thread',
      turns: [{ role: 'user', text: 'w' }],
      droppedParts: 0,
    },
  ],
};

const renderModal = (existing: string[] = []) => {
  const onImport = vi.fn();
  const onClose = vi.fn();
  render(
    <ForeignConversationImportModal
      isOpen
      detection={detection}
      existingIds={new Set(existing)}
      onClose={onClose}
      onImport={onImport}
    />,
  );
  return { onImport, onClose };
};

const rowCheckbox = (title: string) =>
  screen.getByLabelText(new RegExp(title)) as HTMLInputElement;

describe('ForeignConversationImportModal', () => {
  it('pre-selects everything not yet imported and badges already-imported rows', () => {
    renderModal(['import-chatgpt-b']);
    expect(rowCheckbox('Alpha thread').checked).toBe(true);
    expect(rowCheckbox('Beta thread').checked).toBe(false);
    expect(rowCheckbox('Gamma thread').checked).toBe(true);
    expect(screen.getAllByText('alreadyImported')).toHaveLength(1);
  });

  it('imports the selection with the default folder name', () => {
    const { onImport } = renderModal();
    fireEvent.click(rowCheckbox('Gamma thread'));
    fireEvent.click(screen.getByRole('button', { name: /importButton/ }));
    expect(onImport).toHaveBeenCalledTimes(1);
    const [selected, options] = onImport.mock.calls[0];
    expect(selected.map((c: { sourceId: string }) => c.sourceId)).toEqual([
      'a',
      'b',
    ]);
    expect(options.folderName).toBe('defaultFolderName');
  });

  it('passes a null folder when the folder option is unchecked', () => {
    const { onImport } = renderModal();
    fireEvent.click(screen.getByLabelText('placeInFolder'));
    fireEvent.click(screen.getByRole('button', { name: /importButton/ }));
    expect(onImport.mock.calls[0][1]).toEqual({ folderName: null });
  });

  it('filters rows and applies select/deselect to the visible subset only', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('searchPlaceholder'), {
      target: { value: 'beta' },
    });
    expect(screen.queryByText('Alpha thread')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deselectAll' }));
    fireEvent.change(screen.getByLabelText('searchPlaceholder'), {
      target: { value: '' },
    });
    expect(rowCheckbox('Alpha thread').checked).toBe(true);
    expect(rowCheckbox('Beta thread').checked).toBe(false);
  });

  it('disables import when nothing is selected', () => {
    renderModal(['import-chatgpt-a', 'import-chatgpt-b', 'import-chatgpt-c']);
    expect(screen.getByRole('button', { name: /importButton/ })).toBeDisabled();
  });
});
