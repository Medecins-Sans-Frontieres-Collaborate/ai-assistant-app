import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RecoveryCodeInput } from '@/components/Backup/RecoveryCodeInput';

import { describe, expect, it, vi } from 'vitest';

// Pinned vector from the crypto slice: key bytes 0x00..0x1f.
const PINNED_CODE =
  '000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6W';
const PINNED_KEY = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

function getInput(): HTMLInputElement {
  return screen.getByLabelText('input.label');
}

describe('RecoveryCodeInput', () => {
  it('normalizes pasted input: uppercase, O→0, I/L→1, auto dash-grouping', () => {
    render(<RecoveryCodeInput onSubmit={vi.fn()} submitLabel="Go" />);
    const input = getInput();

    // Lowercase + confusables + stray whitespace.
    fireEvent.change(input, { target: { value: ' q7f3 m2o9-xiLx ' } });
    expect(input.value).toBe('Q7F3-M209-X11X');
  });

  it('caps input at 56 significant characters', () => {
    render(<RecoveryCodeInput onSubmit={vi.fn()} submitLabel="Go" />);
    const input = getInput();
    fireEvent.change(input, { target: { value: PINNED_CODE + 'AAAA' } });
    expect(input.value).toBe(PINNED_CODE);
  });

  it('accepts a valid code: shows valid feedback and submits the decoded key', async () => {
    const onSubmit = vi.fn();
    render(<RecoveryCodeInput onSubmit={onSubmit} submitLabel="Go" />);
    const input = getInput();
    const submit = screen.getByRole('button', { name: 'Go' });

    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: PINNED_CODE } });

    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.getByText('input.valid')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');

    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(onSubmit.mock.calls[0][0])).toEqual(PINNED_KEY);
  });

  it('flags a single-character typo via the checksum with aria-invalid', async () => {
    render(<RecoveryCodeInput onSubmit={vi.fn()} submitLabel="Go" />);
    const input = getInput();

    // Last char W→X stays in the alphabet but breaks the checksum.
    fireEvent.change(input, {
      target: { value: PINNED_CODE.slice(0, -1) + 'X' },
    });

    await waitFor(() =>
      expect(screen.getByText('input.checksumError')).toBeInTheDocument(),
    );
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
  });

  it('flags characters outside the alphabet as a format error immediately', () => {
    render(<RecoveryCodeInput onSubmit={vi.fn()} submitLabel="Go" />);
    // U is excluded from Crockford Base32 and not a mapped confusable.
    fireEvent.change(getInput(), { target: { value: 'QU7F' } });
    expect(screen.getByText('input.formatError')).toBeInTheDocument();
    expect(getInput()).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows neutral incomplete feedback while typing', () => {
    render(<RecoveryCodeInput onSubmit={vi.fn()} submitLabel="Go" />);
    fireEvent.change(getInput(), { target: { value: 'Q7F3' } });
    expect(screen.getByText('input.incomplete')).toBeInTheDocument();
    expect(getInput()).toHaveAttribute('aria-invalid', 'false');
  });

  it('announces feedback via an aria-live region tied to the input', () => {
    render(<RecoveryCodeInput onSubmit={vi.fn()} submitLabel="Go" />);
    const input = getInput();
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const region = document.getElementById(describedBy!);
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('surfaces an external error and clears it on edit via onEdit', async () => {
    const onEdit = vi.fn();
    render(
      <RecoveryCodeInput
        onSubmit={vi.fn()}
        submitLabel="Go"
        externalError="wrong backup"
        onEdit={onEdit}
      />,
    );
    const input = getInput();
    expect(screen.getByText('wrong backup')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: PINNED_CODE } });
    expect(onEdit).toHaveBeenCalled();
    // Submit stays disabled while the parent still reports the error.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled(),
    );
  });
});
