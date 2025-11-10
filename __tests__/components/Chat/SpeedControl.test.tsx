import React from 'react';

import { SpeedControl } from '@/components/Chat/Audio/SpeedControl';

import { fireEvent, render, screen } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('SpeedControl', () => {
  const defaultProps = {
    playbackSpeed: 1,
    speeds: [0.75, 1, 1.25, 1.5, 1.75, 2],
    showDropdown: false,
    onToggleDropdown: vi.fn(),
    onChangeSpeed: vi.fn(),
    onClickOutside: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Button Rendering', () => {
    it('renders speed button with current speed', () => {
      render(<SpeedControl {...defaultProps} />);

      expect(screen.getByText('1x')).toBeInTheDocument();
    });

    it('displays different playback speeds', () => {
      render(<SpeedControl {...defaultProps} playbackSpeed={1.5} />);

      expect(screen.getByText('1.5x')).toBeInTheDocument();
    });

    it('button has correct aria-label', () => {
      render(<SpeedControl {...defaultProps} />);

      const button = screen.getByLabelText('Change playback speed');
      expect(button).toBeInTheDocument();
    });

    it('button has title attribute', () => {
      render(<SpeedControl {...defaultProps} />);

      const button = screen.getByTitle('Change playback speed');
      expect(button).toBeInTheDocument();
    });

    it('button contains chevron icon', () => {
      const { container } = render(<SpeedControl {...defaultProps} />);

      const icon = container.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Dropdown Toggle', () => {
    it('calls onToggleDropdown when button is clicked', () => {
      const onToggleDropdown = vi.fn();
      render(
        <SpeedControl {...defaultProps} onToggleDropdown={onToggleDropdown} />,
      );

      const button = screen.getByLabelText('Change playback speed');
      fireEvent.click(button);

      expect(onToggleDropdown).toHaveBeenCalledTimes(1);
    });

    it('does not show dropdown when showDropdown is false', () => {
      render(<SpeedControl {...defaultProps} showDropdown={false} />);

      expect(screen.queryByText('0.75x')).not.toBeInTheDocument();
    });

    it('shows dropdown when showDropdown is true', () => {
      render(<SpeedControl {...defaultProps} showDropdown={true} />);

      expect(screen.getByText('0.75x')).toBeInTheDocument();
      expect(screen.getByText('1.25x')).toBeInTheDocument();
      expect(screen.getByText('1.5x')).toBeInTheDocument();
      expect(screen.getByText('1.75x')).toBeInTheDocument();
      expect(screen.getByText('2x')).toBeInTheDocument();
    });
  });

  describe('Speed Selection', () => {
    it('calls onChangeSpeed when a speed is clicked', () => {
      const onChangeSpeed = vi.fn();
      render(
        <SpeedControl
          {...defaultProps}
          showDropdown={true}
          onChangeSpeed={onChangeSpeed}
        />,
      );

      const speedButton = screen.getByText('1.5x');
      fireEvent.click(speedButton);

      expect(onChangeSpeed).toHaveBeenCalledTimes(1);
      expect(onChangeSpeed).toHaveBeenCalledWith(1.5);
    });

    it('calls onChangeSpeed with correct speed for each option', () => {
      const onChangeSpeed = vi.fn();
      render(
        <SpeedControl
          {...defaultProps}
          showDropdown={true}
          onChangeSpeed={onChangeSpeed}
        />,
      );

      fireEvent.click(screen.getByText('0.75x'));
      expect(onChangeSpeed).toHaveBeenLastCalledWith(0.75);

      fireEvent.click(screen.getByText('2x'));
      expect(onChangeSpeed).toHaveBeenLastCalledWith(2);
    });

    it('highlights current speed in dropdown', () => {
      render(
        <SpeedControl
          {...defaultProps}
          playbackSpeed={1.5}
          showDropdown={true}
        />,
      );

      const speedOptions = screen.getAllByRole('button');
      const highlightedOption = speedOptions.find(
        (option) =>
          option.textContent?.includes('1.5x') &&
          option.classList.contains('font-semibold'),
      );

      expect(highlightedOption).toBeInTheDocument();
    });

    it('does not highlight non-selected speeds', () => {
      render(
        <SpeedControl
          {...defaultProps}
          playbackSpeed={1}
          showDropdown={true}
        />,
      );

      const speedButton = screen.getByText('1.5x');
      expect(speedButton).not.toHaveClass('font-semibold');
    });
  });

  describe('Click Outside Handling', () => {
    it('calls onClickOutside when clicking outside', () => {
      const onClickOutside = vi.fn();
      render(
        <SpeedControl
          {...defaultProps}
          showDropdown={true}
          onClickOutside={onClickOutside}
        />,
      );

      // Click outside the component
      fireEvent.mouseDown(document.body);

      expect(onClickOutside).toHaveBeenCalled();
    });

    it('does not call onClickOutside when clicking inside dropdown', () => {
      const onClickOutside = vi.fn();
      render(
        <SpeedControl
          {...defaultProps}
          showDropdown={true}
          onClickOutside={onClickOutside}
        />,
      );

      const speedButton = screen.getByText('1.5x');
      fireEvent.mouseDown(speedButton);

      expect(onClickOutside).not.toHaveBeenCalled();
    });
  });

  describe('Styling', () => {
    it('button has correct classes', () => {
      render(<SpeedControl {...defaultProps} />);

      const button = screen.getByLabelText('Change playback speed');
      expect(button).toHaveClass('rounded');
      expect(button).toHaveClass('bg-gray-200');
      expect(button).toHaveClass('hover:bg-gray-300');
      expect(button).toHaveClass('dark:bg-gray-700');
    });

    it('dropdown has correct positioning classes', () => {
      const { container } = render(
        <SpeedControl {...defaultProps} showDropdown={true} />,
      );

      const dropdown = container.querySelector('.absolute');
      expect(dropdown).toHaveClass('right-0');
      expect(dropdown).toHaveClass('bottom-full');
      expect(dropdown).toHaveClass('shadow-lg');
    });

    it('dropdown menu items have hover styling', () => {
      render(<SpeedControl {...defaultProps} showDropdown={true} />);

      const speedButton = screen.getByText('1.5x');
      expect(speedButton).toHaveClass('hover:bg-gray-100');
      expect(speedButton).toHaveClass('dark:hover:bg-gray-700');
    });
  });

  describe('Accessibility', () => {
    it('button is keyboard accessible', () => {
      render(<SpeedControl {...defaultProps} />);

      const button = screen.getByLabelText('Change playback speed');
      expect(button.tagName).toBe('BUTTON');
    });

    it('all speed options are buttons', () => {
      render(<SpeedControl {...defaultProps} showDropdown={true} />);

      const speedButtons = screen.getAllByRole('button');
      // Should have main button + all speed options
      expect(speedButtons.length).toBe(defaultProps.speeds.length + 1);
    });
  });

  describe('Custom Speeds', () => {
    it('works with custom speed array', () => {
      const customSpeeds = [0.5, 1, 2, 3];
      render(
        <SpeedControl
          {...defaultProps}
          speeds={customSpeeds}
          showDropdown={true}
        />,
      );

      expect(screen.getByText('0.5x')).toBeInTheDocument();
      expect(screen.getByText('3x')).toBeInTheDocument();
    });

    it('works with single speed option', () => {
      render(
        <SpeedControl {...defaultProps} speeds={[1]} showDropdown={true} />,
      );

      const speedButtons = screen.getAllByRole('button');
      // Main button + 1 speed option
      expect(speedButtons.length).toBe(2);
    });
  });
});
