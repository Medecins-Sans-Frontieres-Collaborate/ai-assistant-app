import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function renderInput(
  props: Partial<React.ComponentProps<typeof ChipListInput>> = {},
) {
  const onChange = vi.fn();
  render(
    <ChipListInput
      values={[]}
      onChange={onChange}
      placeholder="example.org"
      addHint="Press Enter to add"
      removeLabel="Remove"
      {...props}
    />,
  );
  return onChange;
}

describe('ChipListInput', () => {
  it('splits a comma-pasted list into one chip per entry with a single onChange call', () => {
    const onChange = renderInput();
    const input = screen.getByPlaceholderText('example.org');

    fireEvent.change(input, {
      target: { value: 'one.org, two.org,,  three.org ,' },
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['one.org', 'two.org', 'three.org']);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('dedupes case-insensitively against existing values and within the pasted list', () => {
    const onChange = renderInput({ values: ['msf.org'] });
    const input = screen.getByPlaceholderText('Press Enter to add');

    fireEvent.change(input, {
      target: { value: 'MSF.org, new.org, NEW.org' },
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['msf.org', 'new.org']);
  });

  it('does not call onChange when every part is empty or a duplicate', () => {
    const onChange = renderInput({ values: ['msf.org'] });
    const input = screen.getByPlaceholderText('Press Enter to add');

    fireEvent.change(input, { target: { value: ' msf.org , ,' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('applies the normalize prop to each comma-separated part', () => {
    const onChange = renderInput({ normalize: normalizeDomainEntry });
    const input = screen.getByPlaceholderText('example.org');

    fireEvent.change(input, {
      target: { value: 'user@one.org, @two.org, three.org' },
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['one.org', 'two.org', 'three.org']);
  });

  it('normalizeDomainEntry strips everything up to and including the last @', () => {
    expect(normalizeDomainEntry('user@example.org')).toBe('example.org');
    expect(normalizeDomainEntry('@example.org')).toBe('example.org');
    expect(normalizeDomainEntry('a@b@example.org')).toBe('example.org');
    expect(normalizeDomainEntry('example.org')).toBe('example.org');
  });

  it('commits on blur as before (single entry unchanged path)', () => {
    const onChange = renderInput();
    const input = screen.getByPlaceholderText('example.org');

    fireEvent.change(input, { target: { value: 'solo.org' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(['solo.org']);
  });
});

describe('ChipListInput suggestions', () => {
  const PEOPLE = [
    { label: 'Ada Lovelace', value: 'ada@example.org' },
    { label: 'Alan Turing', value: 'alan@example.org' },
  ];

  async function typeAndSettle(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits a picked suggestion as a chip and clears the draft', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    const onChange = vi.fn();
    render(
      <ChipListInput
        values={[]}
        onChange={onChange}
        placeholder="add"
        addHint="more"
        removeLabel="Remove"
        suggest={suggest}
        suggestionsLabel="People"
      />,
    );
    const input = screen.getByPlaceholderText('add');

    await typeAndSettle(input, 'ad');
    fireEvent.mouseDown(screen.getByText('Ada Lovelace'));

    expect(onChange).toHaveBeenCalledWith(['ada@example.org']);
    expect(input).toHaveValue('');
  });

  it('excludes already-added values from the suggestion list', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    render(
      <ChipListInput
        values={['ada@example.org']}
        onChange={vi.fn()}
        placeholder="add"
        addHint="more"
        removeLabel="Remove"
        suggest={suggest}
        suggestionsLabel="People"
      />,
    );

    await typeAndSettle(screen.getByPlaceholderText('more'), 'a');
    await typeAndSettle(screen.getByPlaceholderText('more'), 'al');

    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
  });

  it('Enter with suggestions selects the highlighted person instead of committing the raw draft', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    const onChange = vi.fn();
    render(
      <ChipListInput
        values={[]}
        onChange={onChange}
        placeholder="add"
        addHint="more"
        removeLabel="Remove"
        suggest={suggest}
        suggestionsLabel="People"
      />,
    );
    const input = screen.getByPlaceholderText('add');

    await typeAndSettle(input, 'ad');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith(['ada@example.org']);
  });

  it('Escape dismisses suggestions; Enter then commits the raw draft as before', async () => {
    const suggest = vi.fn(async () => PEOPLE);
    const onChange = vi.fn();
    render(
      <ChipListInput
        values={[]}
        onChange={onChange}
        placeholder="add"
        addHint="more"
        removeLabel="Remove"
        suggest={suggest}
        suggestionsLabel="People"
      />,
    );
    const input = screen.getByPlaceholderText('add');

    await typeAndSettle(input, 'someone@x.org');
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith(['someone@x.org']);
  });
});
