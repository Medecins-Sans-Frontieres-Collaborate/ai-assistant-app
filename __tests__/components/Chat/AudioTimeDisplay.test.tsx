import { render, screen } from '@testing-library/react';
import React from 'react';

import {
  AudioTimeDisplay,
  formatTime,
} from '@/components/Chat/Audio/AudioTimeDisplay';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

describe('formatTime', () => {
  it('formats zero seconds correctly', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('formats seconds under 10 with leading zero', () => {
    expect(formatTime(5)).toBe('0:05');
  });

  it('formats seconds over 10 without leading zero', () => {
    expect(formatTime(45)).toBe('0:45');
  });

  it('formats exactly 60 seconds as 1:00', () => {
    expect(formatTime(60)).toBe('1:00');
  });

  it('formats minutes and seconds correctly', () => {
    expect(formatTime(125)).toBe('2:05');
  });

  it('formats times with seconds >= 10', () => {
    expect(formatTime(135)).toBe('2:15');
  });

  it('handles long durations', () => {
    expect(formatTime(3661)).toBe('61:01'); // Over an hour
  });

  it('handles decimal seconds by flooring', () => {
    expect(formatTime(65.7)).toBe('1:05');
    expect(formatTime(65.3)).toBe('1:05');
  });

  it('formats negative numbers (edge case)', () => {
    // Unlikely in practice, but testing actual behavior
    // -10 seconds: Math.floor(-10 / 60) = -1 min, Math.floor(-10 % 60) = -10 sec
    expect(formatTime(-10)).toBe('-1:0-10');
  });
});

describe('AudioTimeDisplay', () => {
  describe('Rendering', () => {
    it('renders time display', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={1} />,
      );

      expect(screen.getByText(/0:00/)).toBeInTheDocument();
      expect(screen.getByText(/1:40/)).toBeInTheDocument();
    });

    it('displays current time and duration with separator', () => {
      render(
        <AudioTimeDisplay currentTime={30} duration={120} playbackSpeed={1} />,
      );

      const display = screen.getByText(/0:30.*\/.*2:00/);
      expect(display).toBeInTheDocument();
    });

    it('shows formatted current time', () => {
      render(
        <AudioTimeDisplay currentTime={65} duration={200} playbackSpeed={1} />,
      );

      expect(screen.getByText(/1:05/)).toBeInTheDocument();
    });

    it('shows formatted duration', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={185} playbackSpeed={1} />,
      );

      expect(screen.getByText(/3:05/)).toBeInTheDocument();
    });
  });

  describe('Playback Speed Display', () => {
    it('does not show speed when playback speed is 1', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={1} />,
      );

      expect(screen.queryByText(/\(1x\)/)).not.toBeInTheDocument();
    });

    it('shows speed when playback speed is not 1', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={1.5} />,
      );

      expect(screen.getByText('(1.5x)')).toBeInTheDocument();
    });

    it('shows speed for slower playback', () => {
      render(
        <AudioTimeDisplay
          currentTime={0}
          duration={100}
          playbackSpeed={0.75}
        />,
      );

      expect(screen.getByText('(0.75x)')).toBeInTheDocument();
    });

    it('shows speed for faster playback', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={2} />,
      );

      expect(screen.getByText('(2x)')).toBeInTheDocument();
    });

    it('displays speed in parentheses with x suffix', () => {
      render(
        <AudioTimeDisplay
          currentTime={0}
          duration={100}
          playbackSpeed={1.25}
        />,
      );

      const speedDisplay = screen.getByText('(1.25x)');
      expect(speedDisplay).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('has correct container classes', () => {
      const { container } = render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={1} />,
      );

      const timeDisplay = container.firstChild as HTMLElement;
      expect(timeDisplay).toHaveClass('text-xs');
      expect(timeDisplay).toHaveClass('text-gray-600');
      expect(timeDisplay).toHaveClass('dark:text-gray-300');
    });

    it('speed indicator has correct styling', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={1.5} />,
      );

      const speedIndicator = screen.getByText('(1.5x)');
      expect(speedIndicator).toHaveClass('ml-1');
      expect(speedIndicator).toHaveClass('text-xs');
      expect(speedIndicator).toHaveClass('text-gray-500');
      expect(speedIndicator).toHaveClass('dark:text-gray-400');
    });
  });

  describe('Different Time Values', () => {
    it('handles zero duration', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={0} playbackSpeed={1} />,
      );

      expect(screen.getByText(/0:00.*\/.*0:00/)).toBeInTheDocument();
    });

    it('handles matching current time and duration', () => {
      render(
        <AudioTimeDisplay currentTime={60} duration={60} playbackSpeed={1} />,
      );

      expect(screen.getByText(/1:00.*\/.*1:00/)).toBeInTheDocument();
    });

    it('handles current time exceeding duration (edge case)', () => {
      render(
        <AudioTimeDisplay currentTime={100} duration={60} playbackSpeed={1} />,
      );

      expect(screen.getByText(/1:40/)).toBeInTheDocument();
      expect(screen.getByText(/1:00/)).toBeInTheDocument();
    });

    it('handles very short audio (under 1 minute)', () => {
      render(
        <AudioTimeDisplay currentTime={15} duration={30} playbackSpeed={1} />,
      );

      expect(screen.getByText(/0:15.*\/.*0:30/)).toBeInTheDocument();
    });

    it('handles long audio (over 1 hour)', () => {
      render(
        <AudioTimeDisplay
          currentTime={1800}
          duration={3600}
          playbackSpeed={1}
        />,
      );

      expect(screen.getByText(/30:00/)).toBeInTheDocument();
      expect(screen.getByText(/60:00/)).toBeInTheDocument();
    });

    it('handles decimal time values', () => {
      render(
        <AudioTimeDisplay
          currentTime={65.8}
          duration={125.3}
          playbackSpeed={1}
        />,
      );

      expect(screen.getByText(/1:05/)).toBeInTheDocument();
      expect(screen.getByText(/2:05/)).toBeInTheDocument();
    });
  });

  describe('Different Playback Speeds', () => {
    it('handles standard playback speeds', () => {
      const speeds = [0.75, 1.25, 1.5, 1.75, 2];

      speeds.forEach((speed) => {
        const { unmount } = render(
          <AudioTimeDisplay
            currentTime={0}
            duration={100}
            playbackSpeed={speed}
          />,
        );

        expect(screen.getByText(`(${speed}x)`)).toBeInTheDocument();
        unmount();
      });
    });

    it('handles very slow playback speed', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={0.5} />,
      );

      expect(screen.getByText('(0.5x)')).toBeInTheDocument();
    });

    it('handles very fast playback speed', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={100} playbackSpeed={3} />,
      );

      expect(screen.getByText('(3x)')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles NaN values gracefully', () => {
      render(
        <AudioTimeDisplay currentTime={NaN} duration={100} playbackSpeed={1} />,
      );

      // formatTime(NaN) will produce unexpected results, but should not crash
      expect(screen.getByText(/\//)).toBeInTheDocument();
    });

    it('handles negative time values', () => {
      render(
        <AudioTimeDisplay currentTime={-10} duration={100} playbackSpeed={1} />,
      );

      expect(screen.getByText(/\//)).toBeInTheDocument();
    });

    it('handles Infinity duration', () => {
      render(
        <AudioTimeDisplay
          currentTime={0}
          duration={Infinity}
          playbackSpeed={1}
        />,
      );

      // Should not crash
      expect(screen.getByText(/\//)).toBeInTheDocument();
    });
  });

  describe('Real-world Scenarios', () => {
    it('displays initial state (not started)', () => {
      render(
        <AudioTimeDisplay currentTime={0} duration={180} playbackSpeed={1} />,
      );

      expect(screen.getByText(/0:00.*\/.*3:00/)).toBeInTheDocument();
    });

    it('displays mid-playback state', () => {
      render(
        <AudioTimeDisplay currentTime={47} duration={180} playbackSpeed={1} />,
      );

      expect(screen.getByText(/0:47.*\/.*3:00/)).toBeInTheDocument();
    });

    it('displays near-end state', () => {
      render(
        <AudioTimeDisplay currentTime={175} duration={180} playbackSpeed={1} />,
      );

      expect(screen.getByText(/2:55.*\/.*3:00/)).toBeInTheDocument();
    });

    it('displays with fast playback', () => {
      render(
        <AudioTimeDisplay
          currentTime={30}
          duration={120}
          playbackSpeed={1.5}
        />,
      );

      expect(screen.getByText(/0:30.*\/.*2:00/)).toBeInTheDocument();
      expect(screen.getByText('(1.5x)')).toBeInTheDocument();
    });

    it('displays with slow playback', () => {
      render(
        <AudioTimeDisplay
          currentTime={30}
          duration={120}
          playbackSpeed={0.75}
        />,
      );

      expect(screen.getByText(/0:30.*\/.*2:00/)).toBeInTheDocument();
      expect(screen.getByText('(0.75x)')).toBeInTheDocument();
    });
  });
});
