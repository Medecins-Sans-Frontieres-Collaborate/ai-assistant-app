import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import type { TypeaheadFetch } from '@/client/hooks/useTypeaheadSuggestions';

import { EmailAutocompleteInput } from '@/components/UI/EmailAutocompleteInput';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PEOPLE = [
  { label: 'Ada Lovelace', value: 'ada@example.org' },
  { label: 'Alan Turing', value: 'alan@example.org' },
];

/** Controlled harness — the component requires value/onChange from outside. */
function Harness({
  suggest,
  onSelectSuggestion,
  onKeyDown,
}: {
  suggest?: TypeaheadFetch;
  onSelectSuggestion?: (email: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <EmailAutocompleteInput
      value={value}
      onChange={setValue}
      suggest={suggest}
      suggestionsLabel="People"
      onSelectSuggestion={onSelectSuggestion}
      onKeyDown={onKeyDown}
      placeholder="email"
    />
  );
}

async function typeAndSettle(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  // Debounce (300ms) then the resolved fetch promise.
  await act(async () => {
    vi.advanceTimersByTime(400);
    await Promise.resolve();
  });
}

describe('EmailAutocompleteInput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a plain email input when no suggest source is given', () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('email');
    expect(input).not.toHaveAttribute('role');
    fireEvent.change(input, { target: { value: 'someone@x.org' } });
    expect(input).toHaveValue('someone@x.org');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows debounced suggestions and fills the field on click', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    render(<Harness suggest={suggest} />);
    const input = screen.getByPlaceholderText('email');

    await typeAndSettle(input, 'ad');

    expect(suggest).toHaveBeenCalledWith('ad', expect.any(AbortSignal));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();

    // mousedown, matching the component's blur-safe selection
    fireEvent.mouseDown(screen.getByText('Ada Lovelace'));
    expect(input).toHaveValue('ada@example.org');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not fetch below the minimum query length', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    render(<Harness suggest={suggest} />);
    await typeAndSettle(screen.getByPlaceholderText('email'), 'a');
    expect(suggest).not.toHaveBeenCalled();
  });

  it('navigates with arrows and selects with Enter', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    render(<Harness suggest={suggest} />);
    const input = screen.getByPlaceholderText('email');

    await typeAndSettle(input, 'a');
    await typeAndSettle(input, 'al');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('alan@example.org');
  });

  it('prefers onSelectSuggestion over filling the field', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    const onSelect = vi.fn();
    render(<Harness suggest={suggest} onSelectSuggestion={onSelect} />);
    const input = screen.getByPlaceholderText('email');

    await typeAndSettle(input, 'ad');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('ada@example.org');
  });

  it('Escape dismisses; Enter then reaches the caller onKeyDown', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    const onKeyDown = vi.fn();
    render(<Harness suggest={suggest} onKeyDown={onKeyDown} />);
    const input = screen.getByPlaceholderText('email');

    await typeAndSettle(input, 'ad');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalled();
  });

  it('treats fetch failures as no suggestions', async () => {
    const suggest = vi.fn(async () => {
      throw new Error('offline');
    });
    render(<Harness suggest={suggest} />);
    await typeAndSettle(screen.getByPlaceholderText('email'), 'ad');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('EmailAutocompleteInput loading states', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the searching indicator immediately while typing, before the debounce fires', () => {
    const suggest = vi.fn(async () => PEOPLE);
    render(<Harness suggest={suggest} />);
    const input = screen.getByPlaceholderText('email');

    fireEvent.change(input, { target: { value: 'ad' } });

    // No timers advanced: the fetch hasn't even been scheduled yet, but the
    // field already reads as assisted.
    expect(suggest).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Searching your organization…',
    );
    expect(input).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a no-matches row when the search resolves empty', async () => {
    const suggest = vi.fn(async () => []);
    render(<Harness suggest={suggest} />);
    const input = screen.getByPlaceholderText('email');

    fireEvent.change(input, { target: { value: 'zz' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'No directory matches — you can enter the address manually',
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows nothing after a failed search — broken assistance never claims "no matches"', async () => {
    const suggest = vi.fn(async () => {
      throw new Error('offline');
    });
    render(<Harness suggest={suggest} />);
    const input = screen.getByPlaceholderText('email');

    fireEvent.change(input, { target: { value: 'ad' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('clears the searching indicator when the token drops below the minimum', () => {
    const suggest = vi.fn(async () => PEOPLE);
    render(<Harness suggest={suggest} />);
    const input = screen.getByPlaceholderText('email');

    fireEvent.change(input, { target: { value: 'ad' } });
    expect(screen.getByRole('status')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
