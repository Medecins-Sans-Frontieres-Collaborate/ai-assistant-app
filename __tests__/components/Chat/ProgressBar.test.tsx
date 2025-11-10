import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ProgressBar } from '@/components/Chat/Audio/ProgressBar';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('ProgressBar', () => {
  describe('Rendering', () => {
    it('renders progress bar container', () => {
      render(<ProgressBar progress={0} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toBeInTheDocument();
    });

    it('renders progress fill element', () => {
      const { container } = render(
        <ProgressBar progress={50} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector('.bg-blue-500');
      expect(progressFill).toBeInTheDocument();
    });

    it('displays progress at 0%', () => {
      const { container } = render(
        <ProgressBar progress={0} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '0%' });
    });

    it('displays progress at 50%', () => {
      const { container } = render(
        <ProgressBar progress={50} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '50%' });
    });

    it('displays progress at 100%', () => {
      const { container } = render(
        <ProgressBar progress={100} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '100%' });
    });
  });

  describe('Accessibility', () => {
    it('has progressbar role', () => {
      render(<ProgressBar progress={50} onSeek={vi.fn()} />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('has aria-valuenow matching progress', () => {
      render(<ProgressBar progress={75} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuenow', '75');
    });

    it('rounds aria-valuenow to nearest integer', () => {
      render(<ProgressBar progress={75.7} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuenow', '76');
    });

    it('has aria-valuemin of 0', () => {
      render(<ProgressBar progress={50} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuemin', '0');
    });

    it('has aria-valuemax of 100', () => {
      render(<ProgressBar progress={50} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuemax', '100');
    });

    it('has aria-label', () => {
      render(<ProgressBar progress={50} onSeek={vi.fn()} />);

      const progressBar = screen.getByLabelText('Audio progress');
      expect(progressBar).toBeInTheDocument();
    });

    it('updates aria-valuenow when progress changes', () => {
      const { rerender } = render(
        <ProgressBar progress={25} onSeek={vi.fn()} />,
      );

      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '25',
      );

      rerender(<ProgressBar progress={75} onSeek={vi.fn()} />);

      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '75',
      );
    });
  });

  describe('Click Behavior', () => {
    it('calls onSeek when clicked', () => {
      const onSeek = vi.fn();
      render(<ProgressBar progress={50} onSeek={onSeek} />);

      const progressBar = screen.getByRole('progressbar');
      fireEvent.click(progressBar);

      expect(onSeek).toHaveBeenCalledTimes(1);
    });

    it('passes event object to onSeek', () => {
      const onSeek = vi.fn();
      render(<ProgressBar progress={50} onSeek={onSeek} />);

      const progressBar = screen.getByRole('progressbar');
      fireEvent.click(progressBar);

      expect(onSeek).toHaveBeenCalledWith(expect.any(Object));
    });

    it('handles multiple clicks', () => {
      const onSeek = vi.fn();
      render(<ProgressBar progress={50} onSeek={onSeek} />);

      const progressBar = screen.getByRole('progressbar');
      fireEvent.click(progressBar);
      fireEvent.click(progressBar);
      fireEvent.click(progressBar);

      expect(onSeek).toHaveBeenCalledTimes(3);
    });

    it('works with different onSeek functions', () => {
      const onSeek1 = vi.fn();
      const { rerender } = render(
        <ProgressBar progress={50} onSeek={onSeek1} />,
      );

      fireEvent.click(screen.getByRole('progressbar'));
      expect(onSeek1).toHaveBeenCalledTimes(1);

      const onSeek2 = vi.fn();
      rerender(<ProgressBar progress={50} onSeek={onSeek2} />);

      fireEvent.click(screen.getByRole('progressbar'));
      expect(onSeek2).toHaveBeenCalledTimes(1);
      expect(onSeek1).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  describe('Styling', () => {
    it('container has correct base classes', () => {
      render(<ProgressBar progress={50} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveClass('relative');
      expect(progressBar).toHaveClass('h-2');
      expect(progressBar).toHaveClass('rounded-full');
    });

    it('container has background classes', () => {
      render(<ProgressBar progress={50} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveClass('bg-gray-200');
      expect(progressBar).toHaveClass('dark:bg-gray-700');
    });

    it('container has cursor-pointer class', () => {
      render(<ProgressBar progress={50} onSeek={vi.fn()} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveClass('cursor-pointer');
    });

    it('progress fill has correct positioning classes', () => {
      const { container } = render(
        <ProgressBar progress={50} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveClass('absolute');
      expect(progressFill).toHaveClass('top-0');
      expect(progressFill).toHaveClass('left-0');
      expect(progressFill).toHaveClass('h-2');
      expect(progressFill).toHaveClass('rounded-full');
    });

    it('progress fill has correct color classes', () => {
      const { container } = render(
        <ProgressBar progress={50} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveClass('bg-blue-500');
      expect(progressFill).toHaveClass('dark:bg-blue-600');
    });

    it('progress fill has transition classes', () => {
      const { container } = render(
        <ProgressBar progress={50} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveClass('transition-all');
      expect(progressFill).toHaveClass('duration-100');
    });
  });

  describe('Different Progress Values', () => {
    it('handles progress at 0', () => {
      const { container } = render(
        <ProgressBar progress={0} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '0%' });
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '0',
      );
    });

    it('handles progress at 25', () => {
      const { container } = render(
        <ProgressBar progress={25} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '25%' });
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '25',
      );
    });

    it('handles progress at 50', () => {
      const { container } = render(
        <ProgressBar progress={50} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '50%' });
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '50',
      );
    });

    it('handles progress at 75', () => {
      const { container } = render(
        <ProgressBar progress={75} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '75%' });
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '75',
      );
    });

    it('handles progress at 100', () => {
      const { container } = render(
        <ProgressBar progress={100} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '100%' });
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '100',
      );
    });

    it('handles decimal progress values', () => {
      const { container } = render(
        <ProgressBar progress={33.333} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '33.333%' });
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '33',
      );
    });

    it('handles very small progress values', () => {
      const { container } = render(
        <ProgressBar progress={0.5} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '0.5%' });
    });

    it('handles progress values over 100 (edge case)', () => {
      const { container } = render(
        <ProgressBar progress={150} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '150%' });
    });

    it('handles negative progress values (edge case)', () => {
      const { container } = render(
        <ProgressBar progress={-10} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '-10%' });
    });
  });

  describe('Progress Updates', () => {
    it('updates width when progress changes', () => {
      const { container, rerender } = render(
        <ProgressBar progress={0} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '0%' });

      rerender(<ProgressBar progress={50} onSeek={vi.fn()} />);
      expect(progressFill).toHaveStyle({ width: '50%' });

      rerender(<ProgressBar progress={100} onSeek={vi.fn()} />);
      expect(progressFill).toHaveStyle({ width: '100%' });
    });

    it('updates aria-valuenow when progress changes', () => {
      const { rerender } = render(
        <ProgressBar progress={0} onSeek={vi.fn()} />,
      );

      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '0',
      );

      rerender(<ProgressBar progress={33} onSeek={vi.fn()} />);
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '33',
      );

      rerender(<ProgressBar progress={67} onSeek={vi.fn()} />);
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '67',
      );
    });

    it('handles rapid progress updates', () => {
      const { container, rerender } = render(
        <ProgressBar progress={0} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;

      for (let i = 0; i <= 100; i += 10) {
        rerender(<ProgressBar progress={i} onSeek={vi.fn()} />);
        expect(progressFill).toHaveStyle({ width: `${i}%` });
      }
    });
  });

  describe('Edge Cases', () => {
    it('handles NaN progress', () => {
      const { container } = render(
        <ProgressBar progress={NaN} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toBeInTheDocument();
      // Should not crash
    });

    it('handles Infinity progress', () => {
      const { container } = render(
        <ProgressBar progress={Infinity} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toBeInTheDocument();
      // Should not crash
    });

    it('clicking on progress fill also triggers onSeek', () => {
      const onSeek = vi.fn();
      const { container } = render(
        <ProgressBar progress={50} onSeek={onSeek} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      fireEvent.click(progressFill);

      expect(onSeek).toHaveBeenCalled();
    });
  });

  describe('Real-world Scenarios', () => {
    it('displays initial state (not started)', () => {
      const { container } = render(
        <ProgressBar progress={0} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '0%' });
    });

    it('displays mid-playback state', () => {
      const { container } = render(
        <ProgressBar progress={47.5} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '47.5%' });
    });

    it('displays near-end state', () => {
      const { container } = render(
        <ProgressBar progress={98.5} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '98.5%' });
    });

    it('displays completed state', () => {
      const { container } = render(
        <ProgressBar progress={100} onSeek={vi.fn()} />,
      );

      const progressFill = container.querySelector(
        '.bg-blue-500',
      ) as HTMLElement;
      expect(progressFill).toHaveStyle({ width: '100%' });
    });
  });
});
