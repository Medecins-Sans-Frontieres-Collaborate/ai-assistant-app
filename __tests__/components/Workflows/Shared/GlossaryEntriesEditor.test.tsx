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

    // All-caps source → auto-detected acronym, saved explicitly (issue #131).
    expect(onChange).toHaveBeenCalledWith([
      ...value,
      { source: 'WASH', target: 'EAH', kind: 'acronym' },
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

  it('follows the typed term for the kind until the user overrides (issue #131)', () => {
    const onChange = vi.fn();
    render(<GlossaryEntriesEditor value={[]} onChange={onChange} />);
    const kind = screen.getByLabelText('entryKind') as HTMLSelectElement;

    fireEvent.change(screen.getByPlaceholderText('sourceTerm'), {
      target: { value: 'cholera' },
    });
    expect(kind.value).toBe('term');
    expect(
      screen.queryByPlaceholderText('sourceExpansion'),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('sourceTerm'), {
      target: { value: 'WHO' },
    });
    expect(kind.value).toBe('acronym');
    expect(screen.getByPlaceholderText('sourceExpansion')).toBeInTheDocument();

    // Explicit override to term sticks even though the source is all caps.
    fireEvent.change(kind, { target: { value: 'term' } });
    expect(kind.value).toBe('term');
    fireEvent.change(screen.getByPlaceholderText('targetTerm'), {
      target: { value: 'qui' },
    });
    fireEvent.click(screen.getByText('addEntry'));
    expect(onChange).toHaveBeenCalledWith([
      { source: 'WHO', target: 'qui', kind: 'term' },
    ]);
  });

  it('saves acronym full names and drops them when blank', () => {
    const onChange = vi.fn();
    render(<GlossaryEntriesEditor value={[]} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('sourceTerm'), {
      target: { value: 'WHO' },
    });
    fireEvent.change(screen.getByPlaceholderText('targetTerm'), {
      target: { value: 'OMS' },
    });
    fireEvent.change(screen.getByPlaceholderText('sourceExpansion'), {
      target: { value: ' World Health Organization ' },
    });
    fireEvent.click(screen.getByText('addEntry'));
    expect(onChange).toHaveBeenCalledWith([
      {
        source: 'WHO',
        target: 'OMS',
        kind: 'acronym',
        sourceExpansion: 'World Health Organization',
      },
    ]);
  });

  it('badges acronym entries in the table', () => {
    render(
      <GlossaryEntriesEditor
        value={[
          { source: 'WHO', target: 'OMS', kind: 'acronym' },
          { source: 'cholera', target: 'choléra' },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText('kindAcronym')).toHaveLength(2); // badge + option
  });
});
