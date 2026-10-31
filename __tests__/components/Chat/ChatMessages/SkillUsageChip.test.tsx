import { fireEvent, render, screen } from '@testing-library/react';

import type { ToolCallRecord } from '@/types/chat';

import { SkillUsageChip } from '@/components/Chat/ChatMessages/SkillUsageChip';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

const record = (overrides: Partial<ToolCallRecord>): ToolCallRecord =>
  ({
    id: 'skills-1',
    name: 'use_skills',
    server_label: 'Skills',
    arguments: null,
    status: 'completed',
    output: null,
    error: null,
    ...overrides,
  }) as ToolCallRecord;

describe('SkillUsageChip', () => {
  it('renders nothing without skill records', () => {
    const { container } = render(<SkillUsageChip toolCalls={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('names each applied skill and how it was selected, with no details toggle when clean', () => {
    render(
      <SkillUsageChip
        toolCalls={[
          record({ output: 'GDPR Guidance (requested)\nReport Style (auto)' }),
        ]}
      />,
    );
    const chip = screen.getByTestId('skill-usage-chip');
    expect(chip).toHaveTextContent('GDPR Guidance (requested)');
    expect(chip).toHaveTextContent('Report Style (auto)');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('flags incomplete use and reveals dropped ids and notes on demand', () => {
    render(
      <SkillUsageChip
        toolCalls={[
          record({
            status: 'incomplete',
            output:
              'GDPR Guidance (requested)\nghost (unavailable)\nAutomatic skill selection unavailable; explicitly selected skills still apply.',
            error: 'Unavailable skills: ghost',
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('skill-usage-chip')).toHaveTextContent(
      'ghost (unavailable)',
    );
    expect(
      screen.queryByText(/Automatic skill selection unavailable/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'showDetails' }));
    expect(
      screen.getByText(/Automatic skill selection unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByText('Unavailable skills: ghost')).toBeInTheDocument();
  });
});
