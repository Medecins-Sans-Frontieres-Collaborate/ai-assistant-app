import { fireEvent, render, screen } from '@testing-library/react';

import { NextIntlClientProvider } from 'next-intl';

import type { ToolCallRecord } from '@/types/chat';

import { SkillUsageChip } from '@/components/Chat/ChatMessages/SkillUsageChip';

import english from '@/messages/en.json';
import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.unmock('next-intl');

const show = (calls: ToolCallRecord[]) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ chat: { skillUsage: english.chat.skillUsage } }}
    >
      <SkillUsageChip toolCalls={calls} />
    </NextIntlClientProvider>,
  );

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
    const { container } = show([]);
    expect(container.firstChild).toBeNull();
  });

  it('keeps requested use visible and puts automatic names behind a quiet disclosure', () => {
    show([
      record({ output: 'GDPR Guidance (requested)\nReport Style (auto)' }),
    ]);
    const chip = screen.getByTestId('skill-usage-chip');
    expect(chip).toHaveTextContent('GDPR Guidance (requested)');
    expect(chip).not.toHaveTextContent('Report Style (auto)');
    const button = screen.getByRole('button', { name: 'Show skill details' });
    expect(button.className).not.toMatch(
      /bg-violet|bg-amber|border-violet|border-amber/,
    );
    fireEvent.click(button);
    expect(chip).toHaveTextContent('Report Style (auto)');
  });

  it('flags incomplete use and reveals dropped ids and notes on demand', () => {
    show([
      record({
        status: 'incomplete',
        output:
          'GDPR Guidance (requested)\nghost (unavailable)\nAutomatic skill selection unavailable; explicitly selected skills still apply.',
        error: 'Unavailable skills: ghost',
      }),
    ]);
    expect(screen.getByTestId('skill-usage-chip')).toHaveTextContent(
      'ghost (unavailable)',
    );
    expect(
      screen.queryByText(/Automatic skill selection unavailable/),
    ).toBeNull();
    expect(screen.getByTestId('skill-usage-chip')).toHaveAttribute(
      'data-attention',
      'required',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show skill details' }));
    expect(
      screen.getByText(/Automatic skill selection unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByText('Unavailable skills: ghost')).toBeInTheDocument();
  });

  it('shows only a small applied count for automatic selections', () => {
    show([record({ output: 'Platform Help (auto)\nReport Style (auto)' })]);
    expect(screen.getByTestId('skill-usage-chip')).toHaveTextContent(
      'Skills · 2 applied',
    );
    expect(screen.queryByText(/Platform Help/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show skill details' }));
    expect(screen.getByText('Platform Help (auto)')).toBeInTheDocument();
  });

  it('keeps optional routing failures neutral and collapsed while preserving diagnostics', () => {
    show([
      record({
        status: 'incomplete',
        output:
          'Automatic skill selection unavailable; explicitly selected skills still apply.',
      }),
    ]);
    expect(screen.getByTestId('skill-usage-chip')).toHaveAttribute(
      'data-attention',
      'background',
    );
    expect(screen.getByTestId('skill-usage-chip')).toHaveTextContent(
      'Skills · Limited',
    );
    expect(
      screen.queryByText(/Automatic skill selection unavailable/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show skill details' }));
    expect(
      screen.getByText(/Automatic skill selection unavailable/),
    ).toBeInTheDocument();
  });

  it('does not briefly present an in-progress skill tool as a warning or completed use', () => {
    const { container } = show([
      record({
        name: 'load_skill',
        status: 'in_progress',
        arguments: '{"skillId":"report"}',
      }),
    ]);
    expect(container.firstChild).toBeNull();
  });

  it('keeps approval requirements visible without opening details', () => {
    show([record({ output: 'Travel Guidance (needs approval)' })]);
    expect(screen.getByTestId('skill-usage-chip')).toHaveAttribute(
      'data-attention',
      'required',
    );
    expect(
      screen.getByText(/Travel Guidance \(needs your approval\)/),
    ).toBeInTheDocument();
  });
});
