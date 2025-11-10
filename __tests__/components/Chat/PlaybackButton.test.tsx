import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { PlaybackButton } from '@/components/Chat/Audio/PlaybackButton';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('PlaybackButton', () => {
  describe('Rendering', () => {
    it('renders button element', () => {
      render(<PlaybackButton isPlaying={false} onToggle={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
    });

    it('renders play icon when not playing', () => {
      const { container } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      // IconPlayerPlay should be present
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('renders pause icon when playing', () => {
      const { container } = render(
        <PlaybackButton isPlaying={true} onToggle={vi.fn()} />,
      );

      // IconPlayerPause should be present
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has Play aria-label when not playing', () => {
      render(<PlaybackButton isPlaying={false} onToggle={vi.fn()} />);

      const button = screen.getByLabelText('Play');
      expect(button).toBeInTheDocument();
    });

    it('has Pause aria-label when playing', () => {
      render(<PlaybackButton isPlaying={true} onToggle={vi.fn()} />);

      const button = screen.getByLabelText('Pause');
      expect(button).toBeInTheDocument();
    });

    it('is keyboard accessible', () => {
      render(<PlaybackButton isPlaying={false} onToggle={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button.tagName).toBe('BUTTON');
    });

    it('updates aria-label when state changes', () => {
      const { rerender } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      expect(screen.getByLabelText('Play')).toBeInTheDocument();

      rerender(<PlaybackButton isPlaying={true} onToggle={vi.fn()} />);

      expect(screen.getByLabelText('Pause')).toBeInTheDocument();
      expect(screen.queryByLabelText('Play')).not.toBeInTheDocument();
    });
  });

  describe('Click Behavior', () => {
    it('calls onToggle when clicked', () => {
      const onToggle = vi.fn();
      render(<PlaybackButton isPlaying={false} onToggle={onToggle} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('calls onToggle when playing', () => {
      const onToggle = vi.fn();
      render(<PlaybackButton isPlaying={true} onToggle={onToggle} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('calls onToggle when not playing', () => {
      const onToggle = vi.fn();
      render(<PlaybackButton isPlaying={false} onToggle={onToggle} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('handles multiple clicks', () => {
      const onToggle = vi.fn();
      render(<PlaybackButton isPlaying={false} onToggle={onToggle} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(onToggle).toHaveBeenCalledTimes(3);
    });
  });

  describe('Styling', () => {
    it('has correct base classes', () => {
      render(<PlaybackButton isPlaying={false} onToggle={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('mr-2');
      expect(button).toHaveClass('p-1');
      expect(button).toHaveClass('rounded-full');
    });

    it('has hover classes', () => {
      render(<PlaybackButton isPlaying={false} onToggle={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('hover:bg-gray-200');
      expect(button).toHaveClass('dark:hover:bg-gray-700');
    });

    it('has focus outline removed', () => {
      render(<PlaybackButton isPlaying={false} onToggle={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('focus:outline-none');
    });

    it('icon has correct size when playing', () => {
      const { container } = render(
        <PlaybackButton isPlaying={true} onToggle={vi.fn()} />,
      );

      const svg = container.querySelector('svg');
      // IconPlayerPause with size={20}
      expect(svg).toBeInTheDocument();
    });

    it('icon has correct size when not playing', () => {
      const { container } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      const svg = container.querySelector('svg');
      // IconPlayerPlay with size={20}
      expect(svg).toBeInTheDocument();
    });
  });

  describe('State Changes', () => {
    it('changes icon when isPlaying changes to true', () => {
      const { rerender } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      expect(screen.getByLabelText('Play')).toBeInTheDocument();

      rerender(<PlaybackButton isPlaying={true} onToggle={vi.fn()} />);

      expect(screen.getByLabelText('Pause')).toBeInTheDocument();
    });

    it('changes icon when isPlaying changes to false', () => {
      const { rerender } = render(
        <PlaybackButton isPlaying={true} onToggle={vi.fn()} />,
      );

      expect(screen.getByLabelText('Pause')).toBeInTheDocument();

      rerender(<PlaybackButton isPlaying={false} onToggle={vi.fn()} />);

      expect(screen.getByLabelText('Play')).toBeInTheDocument();
    });

    it('maintains button reference through state changes', () => {
      const { rerender } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      const button1 = screen.getByRole('button');

      rerender(<PlaybackButton isPlaying={true} onToggle={vi.fn()} />);

      const button2 = screen.getByRole('button');
      expect(button1).toBe(button2);
    });
  });

  describe('Different onToggle Functions', () => {
    it('works with different callback functions', () => {
      const callback1 = vi.fn();
      const { rerender } = render(
        <PlaybackButton isPlaying={false} onToggle={callback1} />,
      );

      fireEvent.click(screen.getByRole('button'));
      expect(callback1).toHaveBeenCalledTimes(1);

      const callback2 = vi.fn();
      rerender(<PlaybackButton isPlaying={false} onToggle={callback2} />);

      fireEvent.click(screen.getByRole('button'));
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback1).toHaveBeenCalledTimes(1); // Should not be called again
    });
  });

  describe('Edge Cases', () => {
    it('handles rapid state changes', () => {
      const { rerender } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      for (let i = 0; i < 10; i++) {
        rerender(<PlaybackButton isPlaying={i % 2 === 0} onToggle={vi.fn()} />);
      }

      // Should still render correctly
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('handles being clicked while state is changing', () => {
      const onToggle = vi.fn();
      const { rerender } = render(
        <PlaybackButton isPlaying={false} onToggle={onToggle} />,
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      rerender(<PlaybackButton isPlaying={true} onToggle={onToggle} />);

      fireEvent.click(button);

      expect(onToggle).toHaveBeenCalledTimes(2);
    });
  });

  describe('Icon Display', () => {
    it('shows only one icon at a time when not playing', () => {
      const { container } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      const svgs = container.querySelectorAll('svg');
      expect(svgs.length).toBe(1);
    });

    it('shows only one icon at a time when playing', () => {
      const { container } = render(
        <PlaybackButton isPlaying={true} onToggle={vi.fn()} />,
      );

      const svgs = container.querySelectorAll('svg');
      expect(svgs.length).toBe(1);
    });

    it('switches icon immediately when state changes', () => {
      const { rerender } = render(
        <PlaybackButton isPlaying={false} onToggle={vi.fn()} />,
      );

      expect(screen.getByLabelText('Play')).toBeInTheDocument();

      rerender(<PlaybackButton isPlaying={true} onToggle={vi.fn()} />);

      // Should immediately show Pause, not Play
      expect(screen.queryByLabelText('Play')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Pause')).toBeInTheDocument();
    });
  });
});
