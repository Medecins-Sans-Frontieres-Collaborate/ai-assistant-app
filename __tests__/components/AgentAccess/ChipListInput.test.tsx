import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';

import { describe, expect, it, vi } from 'vitest';

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
