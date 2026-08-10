import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { LimitValueInput } from '@/components/Limits/LimitValueInput';

import { getLimitDefinition } from '@/config/limits';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      valueModeLabel: 'Limit type',
      valueAmountLabel: 'Limit amount',
      modeInherit: 'Not set — inherit',
      modeUnlimited: 'Unlimited',
      modeAllowed: 'Allowed',
      modeLimited: 'Limited to',
      modeBlocked: 'Blocked',
      blockedChip: 'Blocked',
      hardCeilingHint: `Cannot exceed ${values?.value ?? ''}`,
    };
    return translations[key] ?? key;
  },
}));

const COUNTER = getLimitDefinition('chat.messagesPerDay')!;
const BOOLEAN_GATE = getLimitDefinition('feature.webSearch.enabled')!;
const CEILING = getLimitDefinition('feature.mcp.roundsPerRequest')!;

describe('LimitValueInput', () => {
  const onChange = vi.fn();

  beforeEach(() => onChange.mockClear());

  /**
   * The three states are the whole point of this control: "clear the field and
   * it reverts to the default" would be wrong for a feature where clearing can
   * mean GRANTING unlimited access.
   */
  it('renders undefined as "Not set — inherit"', () => {
    render(
      <LimitValueInput def={COUNTER} value={undefined} onChange={onChange} />,
    );
    expect(screen.getByLabelText('Limit type')).toHaveValue('inherit');
  });

  it('renders an explicit null as "Unlimited", distinctly from inherit', () => {
    render(<LimitValueInput def={COUNTER} value={null} onChange={onChange} />);
    expect(screen.getByLabelText('Limit type')).toHaveValue('unlimited');
  });

  it('renders a number as "Limited to" with the amount shown', () => {
    render(<LimitValueInput def={COUNTER} value={50} onChange={onChange} />);
    expect(screen.getByLabelText('Limit type')).toHaveValue('limited');
    expect(screen.getByLabelText('Limit amount')).toHaveValue(50);
  });

  it('renders 0 as an explicit Blocked chip, never as an empty field', () => {
    render(<LimitValueInput def={COUNTER} value={0} onChange={onChange} />);
    expect(screen.getByLabelText('Limit type')).toHaveValue('blocked');
    // "Blocked" also appears as a <option> label, so assert the CHIP
    // specifically — the visible confirmation that 0 means blocked.
    const chip = screen
      .getAllByText('Blocked')
      .find((el) => el.tagName !== 'OPTION');
    expect(chip).toBeInTheDocument();
    expect(screen.queryByLabelText('Limit amount')).not.toBeInTheDocument();
  });

  it('emits undefined (not null) when switching to inherit', () => {
    render(<LimitValueInput def={COUNTER} value={5} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Limit type'), {
      target: { value: 'inherit' },
    });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('emits null (not undefined) when switching to unlimited', () => {
    render(<LimitValueInput def={COUNTER} value={5} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Limit type'), {
      target: { value: 'unlimited' },
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('emits 0 when a numeric limit is blocked', () => {
    render(<LimitValueInput def={COUNTER} value={5} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Limit type'), {
      target: { value: 'blocked' },
    });
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('hides "Limited to" for boolean gates and emits false when blocked', () => {
    render(
      <LimitValueInput def={BOOLEAN_GATE} value={true} onChange={onChange} />,
    );
    const select = screen.getByLabelText('Limit type');
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => o.value),
    ).not.toContain('limited');

    fireEvent.change(select, { target: { value: 'blocked' } });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('emits true when a boolean gate is set back to allowed', () => {
    render(
      <LimitValueInput def={BOOLEAN_GATE} value={false} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Limit type'), {
      target: { value: 'unlimited' },
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('clamps typed input to the compiled hardCeiling', () => {
    render(<LimitValueInput def={CEILING} value={5} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Limit amount'), {
      target: { value: '9999' },
    });
    expect(onChange).toHaveBeenCalledWith(CEILING.hardCeiling);
  });

  it('surfaces the hard ceiling so an admin knows the wall exists', () => {
    render(<LimitValueInput def={CEILING} value={5} onChange={onChange} />);
    expect(
      screen.getByText(`Cannot exceed ${CEILING.hardCeiling}`),
    ).toBeInTheDocument();
  });

  it('omits the inherit option where there is no layer below (global defaults)', () => {
    render(
      <LimitValueInput
        def={COUNTER}
        value={null}
        onChange={onChange}
        allowInherit={false}
      />,
    );
    const select = screen.getByLabelText('Limit type');
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => o.value),
    ).not.toContain('inherit');
  });
});
