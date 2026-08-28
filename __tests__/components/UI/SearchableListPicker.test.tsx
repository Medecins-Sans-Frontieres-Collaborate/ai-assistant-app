import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { useRef } from 'react';

import { SearchableListPicker } from '@/components/UI/SearchableListPicker';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const OPTIONS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma', sublabel: 'third' },
];

interface HarnessProps {
  options?: typeof OPTIONS;
  value?: string | null;
  onSelect?: (id: string | null) => void;
  onClose?: () => void;
  onCreateOption?: (label: string) => void;
  clearOption?: { label: string } | null;
  searchThreshold?: number;
  onParentClick?: () => void;
}

function Harness({
  options = OPTIONS,
  value = null,
  onSelect = () => {},
  onClose = () => {},
  onCreateOption,
  clearOption = null,
  searchThreshold = 0,
  onParentClick,
}: HarnessProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div onClick={onParentClick}>
      <button ref={triggerRef}>trigger</button>
      <SearchableListPicker
        triggerRef={triggerRef}
        isOpen
        onClose={onClose}
        options={options}
        value={value}
        onSelect={onSelect}
        clearOption={clearOption}
        searchPlaceholder="Search…"
        ariaLabel="Pick one"
        noResultsLabel="Nothing"
        searchThreshold={searchThreshold}
        onCreateOption={onCreateOption}
        createLabel={(q) => `Create ${q}`}
      />
    </div>
  );
}

describe('SearchableListPicker', () => {
  it('renders the options and selects on click', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Harness onSelect={onSelect} onClose={onClose} />);

    expect(
      screen.getByRole('listbox', { name: 'Pick one' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Beta/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the search box below the threshold and shows it at/above it', () => {
    const { unmount } = render(<Harness searchThreshold={4} />);
    expect(screen.queryByPlaceholderText('Search…')).toBeNull();
    unmount();

    render(<Harness searchThreshold={3} />);
    expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument();
  });

  it('filters by label and sublabel, and reports no results', () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('Search…');

    fireEvent.change(input, { target: { value: 'third' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Gamma/ })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Nothing')).toBeInTheDocument();
  });

  it('offers to create a non-matching query and calls onCreateOption with the trimmed text', () => {
    const onCreateOption = vi.fn();
    const onClose = vi.fn();
    render(<Harness onCreateOption={onCreateOption} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText('Search…'), {
      target: { value: '  Delta ' },
    });
    fireEvent.click(screen.getByRole('option', { name: 'Create Delta' }));
    expect(onCreateOption).toHaveBeenCalledWith('Delta');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not offer to create an exact (case-insensitive) match', () => {
    render(<Harness onCreateOption={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search…'), {
      target: { value: 'alpha' },
    });
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  });

  it('selects the clear row as null', () => {
    const onSelect = vi.fn();
    render(<Harness clearOption={{ label: 'None' }} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('navigates with the keyboard', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByPlaceholderText('Search…');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('Enter with a single match picks it without arrowing', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByPlaceholderText('Search…');
    fireEvent.change(input, { target: { value: 'gam' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('closes on Escape and on outside mousedown', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.keyDown(screen.getByPlaceholderText('Search…'), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The outside listener is attached a tick after opening.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not let clicks bubble to the React parent that rendered it', () => {
    // React bubbles portal events through the component tree; a row click
    // must not also "click" the sidebar row / list item that owns the picker.
    const onParentClick = vi.fn();
    render(<Harness onParentClick={onParentClick} />);
    fireEvent.click(screen.getByRole('option', { name: /Alpha/ }));
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
