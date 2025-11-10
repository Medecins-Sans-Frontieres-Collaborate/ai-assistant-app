import { fireEvent, render, screen } from '@testing-library/react';

import ThinkingBlock from '@/components/Chat/ChatMessages/ThinkingBlock';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock Streamdown component
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

// Mock Tabler icons
vi.mock('@tabler/icons-react', () => ({
  IconBrain: () => <div data-testid="icon-brain">Brain Icon</div>,
  IconChevronDown: () => <div data-testid="icon-chevron-down">Down</div>,
  IconChevronRight: () => <div data-testid="icon-chevron-right">Right</div>,
}));

/**
 * Tests for ThinkingBlock component
 * Displays reasoning/thinking process from o3 models with expand/collapse functionality
 */
describe('ThinkingBlock', () => {
  describe('Rendering', () => {
    it('renders with thinking content', () => {
      render(<ThinkingBlock thinking="Step 1: Analyze the problem..." />);

      expect(screen.getByText('View reasoning process')).toBeInTheDocument();
      expect(screen.getByTestId('icon-brain')).toBeInTheDocument();
    });

    it('does not render when thinking is empty string', () => {
      const { container } = render(<ThinkingBlock thinking="" />);

      expect(container.firstChild).toBeNull();
    });

    it('does not render when thinking is only whitespace', () => {
      const { container } = render(<ThinkingBlock thinking="   " />);

      expect(container.firstChild).toBeNull();
    });

    it('does not render when thinking is undefined', () => {
      const { container } = render(
        <ThinkingBlock thinking={undefined as any} />,
      );

      expect(container.firstChild).toBeNull();
    });

    it('renders brain icon', () => {
      render(<ThinkingBlock thinking="Thinking content" />);

      expect(screen.getByTestId('icon-brain')).toBeInTheDocument();
    });
  });

  describe('Streaming State', () => {
    it('shows "Thinking..." when isStreaming is true', () => {
      render(<ThinkingBlock thinking="In progress..." isStreaming={true} />);

      expect(screen.getByText('Thinking...')).toBeInTheDocument();
    });

    it('shows "View reasoning process" when isStreaming is false', () => {
      render(
        <ThinkingBlock thinking="Complete reasoning" isStreaming={false} />,
      );

      expect(screen.getByText('View reasoning process')).toBeInTheDocument();
    });

    it('shows "View reasoning process" when isStreaming is undefined', () => {
      render(<ThinkingBlock thinking="Default state" />);

      expect(screen.getByText('View reasoning process')).toBeInTheDocument();
    });

    it('applies shimmer animation class when streaming', () => {
      render(<ThinkingBlock thinking="Thinking..." isStreaming={true} />);

      const streamingText = screen.getByText('Thinking...');
      expect(streamingText).toHaveClass('animate-shimmer');
    });
  });

  describe('Expand/Collapse Functionality', () => {
    it('starts in collapsed state', () => {
      render(<ThinkingBlock thinking="Test thinking" />);

      // Content should not be visible initially
      expect(screen.queryByTestId('streamdown')).not.toBeInTheDocument();
      expect(screen.getByTestId('icon-chevron-right')).toBeInTheDocument();
    });

    it('expands when clicked', () => {
      render(<ThinkingBlock thinking="Test thinking" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      // Content should now be visible
      expect(screen.getByTestId('streamdown')).toBeInTheDocument();
      expect(screen.getByTestId('icon-chevron-down')).toBeInTheDocument();
    });

    it('collapses when clicked again', () => {
      render(<ThinkingBlock thinking="Test thinking" />);

      const button = screen.getByRole('button');

      // Expand
      fireEvent.click(button);
      expect(screen.getByTestId('streamdown')).toBeInTheDocument();

      // Collapse
      fireEvent.click(button);
      expect(screen.queryByTestId('streamdown')).not.toBeInTheDocument();
    });

    it('toggles multiple times', () => {
      render(<ThinkingBlock thinking="Toggle test" />);

      const button = screen.getByRole('button');

      // Expand
      fireEvent.click(button);
      expect(screen.getByTestId('streamdown')).toBeInTheDocument();

      // Collapse
      fireEvent.click(button);
      expect(screen.queryByTestId('streamdown')).not.toBeInTheDocument();

      // Expand again
      fireEvent.click(button);
      expect(screen.getByTestId('streamdown')).toBeInTheDocument();

      // Collapse again
      fireEvent.click(button);
      expect(screen.queryByTestId('streamdown')).not.toBeInTheDocument();
    });
  });

  describe('ARIA Attributes', () => {
    it('has correct aria-expanded when collapsed', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });

    it('has correct aria-expanded when expanded', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(button).toHaveAttribute('aria-expanded', 'true');
    });

    it('has aria-label for collapsed state', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', 'Expand thinking');
    });

    it('has aria-label for expanded state', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(button).toHaveAttribute('aria-label', 'Collapse thinking');
    });
  });

  describe('Content Display', () => {
    it('displays thinking content when expanded', () => {
      const thinkingText = 'Step 1: Analyze\nStep 2: Plan\nStep 3: Execute';
      render(<ThinkingBlock thinking={thinkingText} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      const streamdown = screen.getByTestId('streamdown');
      // Check that key parts of the content are present
      expect(streamdown.textContent).toContain('Step 1: Analyze');
      expect(streamdown.textContent).toContain('Step 2: Plan');
      expect(streamdown.textContent).toContain('Step 3: Execute');
    });

    it('passes thinking content to Streamdown', () => {
      const thinking = 'Detailed reasoning process...';
      render(<ThinkingBlock thinking={thinking} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByTestId('streamdown')).toHaveTextContent(thinking);
    });

    it('handles multi-line thinking content', () => {
      const multiLineThinking = `Step 1: First analyze the problem
Step 2: Break it down into components
Step 3: Solve each component
Step 4: Combine solutions`;

      render(<ThinkingBlock thinking={multiLineThinking} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      const streamdown = screen.getByTestId('streamdown');
      // Verify all lines are present
      expect(streamdown.textContent).toContain('First analyze the problem');
      expect(streamdown.textContent).toContain('Break it down into components');
      expect(streamdown.textContent).toContain('Solve each component');
      expect(streamdown.textContent).toContain('Combine solutions');
    });

    it('handles special characters in thinking content', () => {
      const specialChars = 'Math: 2 + 2 = 4, Logic: A && B || C';
      render(<ThinkingBlock thinking={specialChars} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByTestId('streamdown')).toHaveTextContent(specialChars);
    });
  });

  describe('Styling', () => {
    it('has correct container classes', () => {
      render(<ThinkingBlock thinking="Test" />);

      const container = screen.getByRole('button').parentElement;
      expect(container).toHaveClass('mb-3');
      expect(container).toHaveClass('border');
      expect(container).toHaveClass('rounded-lg');
    });

    it('button spans full width', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('w-full');
    });

    it('applies correct color scheme classes', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-blue-700');
      expect(button).toHaveClass('dark:text-blue-300');
    });
  });

  describe('Icon Display', () => {
    it('shows chevron right icon when collapsed', () => {
      render(<ThinkingBlock thinking="Test" />);

      expect(screen.getByTestId('icon-chevron-right')).toBeInTheDocument();
      expect(screen.queryByTestId('icon-chevron-down')).not.toBeInTheDocument();
    });

    it('shows chevron down icon when expanded', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByTestId('icon-chevron-down')).toBeInTheDocument();
      expect(
        screen.queryByTestId('icon-chevron-right'),
      ).not.toBeInTheDocument();
    });

    it('toggles icons when expanding and collapsing', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');

      // Initially collapsed - should show right chevron
      expect(screen.getByTestId('icon-chevron-right')).toBeInTheDocument();

      // Expand - should show down chevron
      fireEvent.click(button);
      expect(screen.getByTestId('icon-chevron-down')).toBeInTheDocument();

      // Collapse - should show right chevron again
      fireEvent.click(button);
      expect(screen.getByTestId('icon-chevron-right')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles very long thinking content', () => {
      const longThinking = 'Very long thinking content. '.repeat(1000);
      render(<ThinkingBlock thinking={longThinking} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      const streamdown = screen.getByTestId('streamdown');
      // Verify content is present (checking length is sufficient)
      expect(streamdown.textContent).toContain('Very long thinking content');
      expect(streamdown.textContent!.length).toBeGreaterThan(20000); // 1000 * ~28 chars
    });

    it('handles thinking with only numbers', () => {
      render(<ThinkingBlock thinking="12345" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByTestId('streamdown')).toHaveTextContent('12345');
    });

    it('handles thinking with markdown-like content', () => {
      const markdown = '# Heading\n- List item\n**Bold text**';
      render(<ThinkingBlock thinking={markdown} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      const streamdown = screen.getByTestId('streamdown');
      // Check markdown elements are present
      expect(streamdown.textContent).toContain('# Heading');
      expect(streamdown.textContent).toContain('- List item');
      expect(streamdown.textContent).toContain('**Bold text**');
    });

    it('preserves whitespace in thinking content', () => {
      const contentWithSpaces = '  Leading spaces\n    Indented line';
      render(<ThinkingBlock thinking={contentWithSpaces} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      const streamdown = screen.getByTestId('streamdown');
      // Verify both parts of content are present
      expect(streamdown.textContent).toContain('Leading spaces');
      expect(streamdown.textContent).toContain('Indented line');
    });
  });

  describe('Interaction', () => {
    it('button is clickable', () => {
      render(<ThinkingBlock thinking="Test" />);

      const button = screen.getByRole('button');
      expect(button).toBeEnabled();
    });

    it('maintains state across re-renders', () => {
      const { rerender } = render(<ThinkingBlock thinking="Initial" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByTestId('streamdown')).toBeInTheDocument();

      // Re-render with new thinking content
      rerender(<ThinkingBlock thinking="Updated" />);

      // Should still be expanded
      expect(screen.getByTestId('streamdown')).toBeInTheDocument();
      expect(screen.getByTestId('streamdown')).toHaveTextContent('Updated');
    });

    it('updates streaming state dynamically', () => {
      const { rerender } = render(
        <ThinkingBlock thinking="Processing..." isStreaming={true} />,
      );

      expect(screen.getByText('Thinking...')).toBeInTheDocument();

      rerender(<ThinkingBlock thinking="Processing..." isStreaming={false} />);

      expect(screen.getByText('View reasoning process')).toBeInTheDocument();
      expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    });
  });
});
