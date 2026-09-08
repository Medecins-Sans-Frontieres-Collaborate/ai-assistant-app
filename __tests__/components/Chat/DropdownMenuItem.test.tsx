import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  DropdownMenuItem,
  MenuItem,
} from '@/components/Chat/ChatInput/DropdownMenuItem';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('DropdownMenuItem', () => {
  const TestIcon = () => <svg data-testid="test-icon">Icon</svg>;

  const createMenuItem = (overrides = {}): MenuItem => ({
    id: 'test-item',
    icon: <TestIcon />,
    label: 'Test Item',
    tooltip: 'Test Tooltip',
    onClick: vi.fn(),
    category: 'web',
    ...overrides,
  });

  describe('Rendering', () => {
    it('renders menu item with label', () => {
      const item = createMenuItem({ label: 'Web Search' });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByText('Web Search')).toBeInTheDocument();
    });

    it('renders menu item with icon', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByTestId('test-icon')).toBeInTheDocument();
    });

    it('button has menuitem role', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitem');
      expect(button).toBeInTheDocument();
    });
  });

  describe('Selected State', () => {
    it('applies selected styling when isSelected is true', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={true} />);

      // Row state styling lives on the flex container that wraps the button
      const row = screen.getByRole('menuitem').parentElement as HTMLElement;
      expect(row).toHaveClass('bg-gray-100');
      expect(row).toHaveClass('dark:bg-gray-700');
    });

    it('applies unselected styling when isSelected is false', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const row = screen.getByRole('menuitem').parentElement as HTMLElement;
      expect(row).toHaveClass('hover:bg-gray-100');
      expect(row).toHaveClass('dark:hover:bg-gray-700');
      expect(row).not.toHaveClass('bg-gray-100');
    });

    it('sets aria-current when selected', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={true} />);

      const button = screen.getByRole('menuitem');
      expect(button).toHaveAttribute('aria-current', 'true');
    });

    it('does not set aria-current when not selected', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitem');
      expect(button).not.toHaveAttribute('aria-current');
    });

    it('sets tabIndex to 0 when selected', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={true} />);

      const button = screen.getByRole('menuitem');
      expect(button).toHaveAttribute('tabIndex', '0');
    });

    it('sets tabIndex to -1 when not selected', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitem');
      expect(button).toHaveAttribute('tabIndex', '-1');
    });
  });

  describe('Click Behavior', () => {
    it('calls onClick when clicked', () => {
      const mockOnClick = vi.fn();
      const item = createMenuItem({ onClick: mockOnClick });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitem');
      fireEvent.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('calls onClick when selected and clicked', () => {
      const mockOnClick = vi.fn();
      const item = createMenuItem({ onClick: mockOnClick });
      render(<DropdownMenuItem item={item} isSelected={true} />);

      const button = screen.getByRole('menuitem');
      fireEvent.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('Different Categories', () => {
    it('works with web category', () => {
      const item = createMenuItem({ category: 'web', label: 'Web Search' });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByText('Web Search')).toBeInTheDocument();
    });

    it('works with media category', () => {
      const item = createMenuItem({ category: 'media', label: 'Upload Image' });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });

    it('works with transform category', () => {
      const item = createMenuItem({
        category: 'transform',
        label: 'Translate',
      });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByText('Translate')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('has correct base classes', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitem');
      expect(button).toHaveClass('flex');
      expect(button).toHaveClass('items-center');
      expect(button).toHaveClass('text-left');
      // The rounded row affordance is on the wrapping container
      const row = button.parentElement as HTMLElement;
      expect(row).toHaveClass('rounded-md');
    });

    it('has transition classes', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const row = screen.getByRole('menuitem').parentElement as HTMLElement;
      expect(row).toHaveClass('transition-colors');
      expect(row).toHaveClass('duration-150');
    });
  });

  describe('Accessibility', () => {
    it('button is keyboard accessible', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitem');
      expect(button.tagName).toBe('BUTTON');
    });

    it('has proper ARIA role', () => {
      const item = createMenuItem();
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByRole('menuitem')).toBeInTheDocument();
    });
  });

  describe('Different Icons', () => {
    it('renders different icon components', () => {
      const CustomIcon = () => <div data-testid="custom-icon">Custom</div>;
      const item = createMenuItem({ icon: <CustomIcon /> });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
    });

    it('handles no icon gracefully', () => {
      const item = createMenuItem({ icon: null });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      expect(screen.getByRole('menuitem')).toBeInTheDocument();
    });
  });

  describe('Policy lock and notes (usage limits §7.4)', () => {
    it('a lockReason disables the row, shows a lock, and exposes the reason', () => {
      const onClick = vi.fn();
      const item = createMenuItem({
        id: 'search',
        onClick,
        toggle: true,
        checked: true,
        lockReason: 'Web search is off on your account',
      });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitemcheckbox');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute(
        'title',
        'Web search is off on your account',
      );
      expect(screen.getByTestId('dropdown-lock-search')).toHaveAttribute(
        'aria-label',
        'Web search is off on your account',
      );
      // A locked toggle never shows the on-state mark, whatever `checked` says.
      expect(button.parentElement?.querySelector('.text-blue-500')).toBeNull();

      fireEvent.click(button);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('renders a note under the label with the requested tone', () => {
      const item = createMenuItem({
        note: '2 left today',
        noteTone: 'warning',
      });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const note = screen.getByText('2 left today');
      expect(note).toHaveClass('text-amber-700');
      expect(screen.getByRole('menuitem')).toBeEnabled();
    });

    it('without lockReason or note the row is unchanged', () => {
      const item = createMenuItem({ toggle: true, checked: true });
      render(<DropdownMenuItem item={item} isSelected={false} />);

      const button = screen.getByRole('menuitemcheckbox');
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('title');
      expect(screen.queryByTestId('dropdown-lock-test-item')).toBeNull();
    });
  });
});
