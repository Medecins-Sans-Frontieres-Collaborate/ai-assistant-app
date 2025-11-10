import React from 'react';

import { DropdownSearchInput } from '@/components/Chat/ChatInput/DropdownSearchInput';

import { fireEvent, render, screen } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('DropdownSearchInput', () => {
  const defaultProps = {
    value: '',
    onChange: vi.fn(),
    onClear: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders search input', () => {
      render(<DropdownSearchInput {...defaultProps} />);

      const input = screen.getByRole('searchbox');
      expect(input).toBeInTheDocument();
    });

    it('displays default placeholder', () => {
      render(<DropdownSearchInput {...defaultProps} />);

      expect(
        screen.getByPlaceholderText('Search features...'),
      ).toBeInTheDocument();
    });

    it('displays custom placeholder', () => {
      render(
        <DropdownSearchInput {...defaultProps} placeholder="Search items..." />,
      );

      expect(
        screen.getByPlaceholderText('Search items...'),
      ).toBeInTheDocument();
    });

    it('renders search icon', () => {
      const { container } = render(<DropdownSearchInput {...defaultProps} />);

      // IconSearch should be present
      const icons = container.querySelectorAll('svg');
      expect(icons.length).toBeGreaterThan(0);
    });

    it('displays current value', () => {
      render(<DropdownSearchInput {...defaultProps} value="test query" />);

      const input = screen.getByRole('searchbox') as HTMLInputElement;
      expect(input.value).toBe('test query');
    });
  });

  describe('Input Behavior', () => {
    it('calls onChange when typing', () => {
      const onChange = vi.fn();
      render(<DropdownSearchInput {...defaultProps} onChange={onChange} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'search text' } });

      expect(onChange).toHaveBeenCalledWith('search text');
    });

    it('calls onChange for each keystroke', () => {
      const onChange = vi.fn();
      render(<DropdownSearchInput {...defaultProps} onChange={onChange} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 's' } });
      fireEvent.change(input, { target: { value: 'se' } });
      fireEvent.change(input, { target: { value: 'sea' } });

      expect(onChange).toHaveBeenCalledTimes(3);
      expect(onChange).toHaveBeenLastCalledWith('sea');
    });
  });

  describe('Clear Button', () => {
    it('does not show clear button when input is empty', () => {
      render(<DropdownSearchInput {...defaultProps} value="" />);

      expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
    });

    it('shows clear button when input has value', () => {
      render(<DropdownSearchInput {...defaultProps} value="test" />);

      expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
    });

    it('calls onClear when clear button is clicked', () => {
      const onClear = vi.fn();
      render(
        <DropdownSearchInput
          {...defaultProps}
          value="test"
          onClear={onClear}
        />,
      );

      const clearButton = screen.getByLabelText('Clear search');
      fireEvent.click(clearButton);

      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('clear button has X icon', () => {
      const { container } = render(
        <DropdownSearchInput {...defaultProps} value="test" />,
      );

      const clearButton = screen.getByLabelText('Clear search');
      expect(clearButton.querySelector('svg')).toBeInTheDocument();
    });
  });

  describe('Input Reference', () => {
    it('accepts and uses inputRef', () => {
      const inputRef = React.createRef<HTMLInputElement>();
      render(<DropdownSearchInput {...defaultProps} inputRef={inputRef} />);

      expect(inputRef.current).toBeInstanceOf(HTMLInputElement);
    });

    it('can focus input via ref', () => {
      const inputRef = React.createRef<HTMLInputElement>();
      render(<DropdownSearchInput {...defaultProps} inputRef={inputRef} />);

      inputRef.current?.focus();

      expect(document.activeElement).toBe(inputRef.current);
    });
  });

  describe('Styling', () => {
    it('has correct container classes', () => {
      const { container } = render(<DropdownSearchInput {...defaultProps} />);

      const containerDiv = container.firstChild as HTMLElement;
      expect(containerDiv).toHaveClass('sticky');
      expect(containerDiv).toHaveClass('top-0');
      expect(containerDiv).toHaveClass('border-b');
    });

    it('input has correct styling classes', () => {
      render(<DropdownSearchInput {...defaultProps} />);

      const input = screen.getByRole('searchbox');
      expect(input).toHaveClass('w-full');
      expect(input).toHaveClass('rounded-md');
      expect(input).toHaveClass('border');
      expect(input).toHaveClass('focus:ring-2');
      expect(input).toHaveClass('focus:ring-blue-500');
    });

    it('has dark mode classes', () => {
      render(<DropdownSearchInput {...defaultProps} />);

      const input = screen.getByRole('searchbox');
      expect(input).toHaveClass('dark:bg-gray-900');
      expect(input).toHaveClass('dark:text-white');
      expect(input).toHaveClass('dark:border-gray-600');
    });

    it('search icon has correct positioning', () => {
      const { container } = render(<DropdownSearchInput {...defaultProps} />);

      // First SVG should be the search icon
      const searchIcon = container.querySelector('.absolute.left-3');
      expect(searchIcon).toBeInTheDocument();
    });

    it('clear button has hover styling', () => {
      render(<DropdownSearchInput {...defaultProps} value="test" />);

      const clearButton = screen.getByLabelText('Clear search');
      expect(clearButton).toHaveClass('hover:text-gray-600');
      expect(clearButton).toHaveClass('dark:hover:text-gray-300');
    });
  });

  describe('Accessibility', () => {
    it('has searchbox role', () => {
      render(<DropdownSearchInput {...defaultProps} />);

      expect(screen.getByRole('searchbox')).toBeInTheDocument();
    });

    it('input has aria-label', () => {
      render(<DropdownSearchInput {...defaultProps} />);

      const input = screen.getByLabelText('Search features');
      expect(input).toBeInTheDocument();
    });

    it('clear button has aria-label', () => {
      render(<DropdownSearchInput {...defaultProps} value="test" />);

      const clearButton = screen.getByLabelText('Clear search');
      expect(clearButton).toBeInTheDocument();
    });

    it('input is keyboard accessible', () => {
      render(<DropdownSearchInput {...defaultProps} />);

      const input = screen.getByRole('searchbox');
      expect(input.tagName).toBe('INPUT');
      expect(input).toHaveAttribute('type', 'text');
    });
  });

  describe('Edge Cases', () => {
    it('handles very long search queries', () => {
      const longValue = 'a'.repeat(100);
      render(<DropdownSearchInput {...defaultProps} value={longValue} />);

      const input = screen.getByRole('searchbox') as HTMLInputElement;
      expect(input.value).toBe(longValue);
    });

    it('handles special characters', () => {
      const onChange = vi.fn();
      render(<DropdownSearchInput {...defaultProps} onChange={onChange} />);

      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: '!@#$%^&*()' } });

      expect(onChange).toHaveBeenCalledWith('!@#$%^&*()');
    });

    it('handles whitespace', () => {
      render(<DropdownSearchInput {...defaultProps} value="  spaces  " />);

      const input = screen.getByRole('searchbox') as HTMLInputElement;
      expect(input.value).toBe('  spaces  ');
    });
  });
});
