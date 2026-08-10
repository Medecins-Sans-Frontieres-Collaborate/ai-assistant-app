import { fireEvent, render, screen } from '@testing-library/react';

import { GlossaryEntriesEditor } from '@/components/Workflows/Shared/GlossaryEntriesEditor';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const value = [
  { source: 'IDP', target: 'personne déplacée', note: 'UNHCR usage' },
  { source: 'NFI', target: 'article non alimentaire' },
];

describe('GlossaryEntriesEditor', () => {
  it('renders the entries table', () => {
    render(<GlossaryEntriesEditor value={value} onChange={vi.fn()} />);
    expect(screen.getByText('IDP')).toBeInTheDocument();
    expect(screen.getByText('personne déplacée')).toBeInTheDocument();
    expect(screen.getByText('UNHCR usage')).toBeInTheDocument();
  });

  // The jsdom i18n mock has no workflows namespace, so placeholders/labels
  // render as their raw keys.
  it('commits the add-entry draft through onChange and clears it', () => {
    const onChange = vi.fn();
    render(<GlossaryEntriesEditor value={value} onChange={onChange} />);

    const source = screen.getByPlaceholderText('sourceTerm');
    const target = screen.getByPlaceholderText('targetTerm');
    fireEvent.change(source, { target: { value: ' WASH ' } });
    fireEvent.change(target, { target: { value: 'EAH' } });
    fireEvent.click(screen.getByText('addEntry'));

    expect(onChange).toHaveBeenCalledWith([
      ...value,
      { source: 'WASH', target: 'EAH' },
    ]);
    expect(source).toHaveValue('');
    expect(target).toHaveValue('');
  });

  it('removes an entry through onChange', () => {
    const onChange = vi.fn();
    render(<GlossaryEntriesEditor value={value} onChange={onChange} />);

    fireEvent.click(screen.getAllByLabelText('removeEntry')[0]);
    expect(onChange).toHaveBeenCalledWith([value[1]]);
  });

  it('disables Add until both source and target are set', () => {
    render(<GlossaryEntriesEditor value={[]} onChange={vi.fn()} />);
    const addButton = screen.getByText('addEntry').closest('button');
    expect(addButton).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('sourceTerm'), {
      target: { value: 'IDP' },
    });
    expect(addButton).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('targetTerm'), {
      target: { value: 'PDI' },
    });
    expect(addButton).not.toBeDisabled();
  });
});
