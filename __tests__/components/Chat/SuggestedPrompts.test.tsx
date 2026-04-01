import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { NextIntlClientProvider } from 'next-intl';

import { SuggestedPrompts } from '@/components/Chat/EmptyState/SuggestedPrompts';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Translation messages for testing
const messages = {
  emptyState: {
    suggestedPrompts: {
      createDiagrams: {
        title: 'Create Diagrams',
        prompt: 'Show me how you can create diagrams and flowcharts.',
      },
      draftContent: {
        title: 'Draft Professional Content',
        prompt: 'I need help writing professional documents.',
      },
      analyzeInformation: {
        title: 'Analyze Information',
        prompt: 'How can you help me analyze data or information?',
      },
      planOrganize: {
        title: 'Plan & Organize',
        prompt: 'Can you help me plan projects or organize work?',
      },
      brainstormIdeas: {
        title: 'Brainstorm Ideas',
        prompt: 'I want to brainstorm solutions to a problem.',
      },
      buildPresentations: {
        title: 'Build Presentations',
        prompt: 'How can you help me create presentations?',
      },
      workWithCode: {
        title: 'Work with Code',
        prompt: 'Can you help with coding or scripts?',
      },
      decisionSupport: {
        title: 'Decision Support',
        prompt: 'I need to make a decision.',
      },
      summarizeSynthesize: {
        title: 'Summarize & Synthesize',
        prompt: 'How do you help with summarizing?',
      },
      explainTopics: {
        title: 'Explain Complex Topics',
        prompt: 'Can you explain complicated concepts?',
      },
      createSchedules: {
        title: 'Create Schedules',
        prompt: 'I need help organizing time.',
      },
    },
  },
};

const PROMPT_KEYS = [
  'createDiagrams',
  'draftContent',
  'analyzeInformation',
  'planOrganize',
  'brainstormIdeas',
  'buildPresentations',
  'workWithCode',
  'decisionSupport',
  'summarizeSynthesize',
  'explainTopics',
  'createSchedules',
];

/**
 * Wrapper component that provides i18n context for tests.
 */
function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe('SuggestedPrompts', () => {
  it('renders suggested prompts', () => {
    const { container } = render(
      <TestWrapper>
        <SuggestedPrompts />
      </TestWrapper>,
    );
    expect(container.firstChild).toBeInTheDocument();
  });

  it('displays default 3 prompts', () => {
    render(
      <TestWrapper>
        <SuggestedPrompts />
      </TestWrapper>,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
  });

  it('displays custom number of prompts', () => {
    render(
      <TestWrapper>
        <SuggestedPrompts count={5} />
      </TestWrapper>,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
  });

  it('displays correct prompt titles', () => {
    render(
      <TestWrapper>
        <SuggestedPrompts count={3} />
      </TestWrapper>,
    );

    expect(screen.getByText('Create Diagrams')).toBeInTheDocument();
    expect(screen.getByText('Draft Professional Content')).toBeInTheDocument();
    expect(screen.getByText('Analyze Information')).toBeInTheDocument();
  });

  it('calls onSelectPrompt when prompt is clicked', () => {
    const mockOnSelectPrompt = vi.fn();
    render(
      <TestWrapper>
        <SuggestedPrompts onSelectPrompt={mockOnSelectPrompt} />
      </TestWrapper>,
    );

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(mockOnSelectPrompt).toHaveBeenCalledTimes(1);
    expect(mockOnSelectPrompt).toHaveBeenCalledWith(
      messages.emptyState.suggestedPrompts.createDiagrams.prompt,
    );
  });

  it('calls onSelectPrompt with correct prompt for each button', () => {
    const mockOnSelectPrompt = vi.fn();
    render(
      <TestWrapper>
        <SuggestedPrompts onSelectPrompt={mockOnSelectPrompt} count={3} />
      </TestWrapper>,
    );

    const buttons = screen.getAllByRole('button');

    fireEvent.click(buttons[0]);
    expect(mockOnSelectPrompt).toHaveBeenLastCalledWith(
      messages.emptyState.suggestedPrompts.createDiagrams.prompt,
    );

    fireEvent.click(buttons[1]);
    expect(mockOnSelectPrompt).toHaveBeenLastCalledWith(
      messages.emptyState.suggestedPrompts.draftContent.prompt,
    );

    fireEvent.click(buttons[2]);
    expect(mockOnSelectPrompt).toHaveBeenLastCalledWith(
      messages.emptyState.suggestedPrompts.analyzeInformation.prompt,
    );

    expect(mockOnSelectPrompt).toHaveBeenCalledTimes(3);
  });

  it('works without onSelectPrompt callback', () => {
    render(
      <TestWrapper>
        <SuggestedPrompts />
      </TestWrapper>,
    );
    const buttons = screen.getAllByRole('button');

    expect(() => fireEvent.click(buttons[0])).not.toThrow();
  });

  it('renders icons for each prompt', () => {
    const { container } = render(
      <TestWrapper>
        <SuggestedPrompts count={3} />
      </TestWrapper>,
    );

    const buttons = container.querySelectorAll('button');
    buttons.forEach((button) => {
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  it('has correct styling classes', () => {
    const { container } = render(
      <TestWrapper>
        <SuggestedPrompts />
      </TestWrapper>,
    );

    const wrapper = container.firstChild;
    expect(wrapper).toHaveClass('hidden');
    expect(wrapper).toHaveClass('sm:flex');
    expect(wrapper).toHaveClass('gap-3');
  });

  it('buttons have correct styling', () => {
    render(
      <TestWrapper>
        <SuggestedPrompts />
      </TestWrapper>,
    );

    const buttons = screen.getAllByRole('button');

    buttons.forEach((button) => {
      expect(button).toHaveClass('bg-white');
      expect(button).toHaveClass('dark:bg-surface-dark');
      expect(button).toHaveClass('border');
      expect(button).toHaveClass('rounded-full');
    });
  });

  it('limits prompts to available count', () => {
    render(
      <TestWrapper>
        <SuggestedPrompts count={100} />
      </TestWrapper>,
    );

    const buttons = screen.getAllByRole('button');
    // Should only show as many as exist in PROMPT_KEYS (11)
    expect(buttons.length).toBeLessThanOrEqual(PROMPT_KEYS.length);
  });

  it('displays prompts with flex row layout', () => {
    const { container } = render(
      <TestWrapper>
        <SuggestedPrompts count={2} />
      </TestWrapper>,
    );

    const buttons = container.querySelectorAll('button');
    buttons.forEach((button) => {
      const flexDiv = button.querySelector('.flex-row');
      expect(flexDiv).toBeInTheDocument();
      expect(flexDiv).toHaveClass('items-center');
    });
  });

  it('icons have correct sizing', () => {
    const { container } = render(
      <TestWrapper>
        <SuggestedPrompts count={2} />
      </TestWrapper>,
    );

    const icons = container.querySelectorAll('svg');
    icons.forEach((icon) => {
      expect(icon).toHaveClass('h-3.5');
      expect(icon).toHaveClass('w-3.5');
    });
  });

  it('uses useMemo to avoid hydration mismatch', () => {
    const { rerender } = render(
      <TestWrapper>
        <SuggestedPrompts count={3} />
      </TestWrapper>,
    );

    const firstPrompts = screen
      .getAllByRole('button')
      .map((b) => b.textContent);

    rerender(
      <TestWrapper>
        <SuggestedPrompts count={3} />
      </TestWrapper>,
    );

    const secondPrompts = screen
      .getAllByRole('button')
      .map((b) => b.textContent);

    expect(firstPrompts).toEqual(secondPrompts);
  });
});
