import { formatTime } from '@/lib/utils/audio/formatTime';

import { describe, expect, it } from 'vitest';

describe('formatTime', () => {
  describe('Basic Formatting', () => {
    it('formats zero seconds', () => {
      expect(formatTime(0)).toBe('0:00');
    });

    it('formats seconds less than 10', () => {
      expect(formatTime(5)).toBe('0:05');
    });

    it('formats seconds 10 or more', () => {
      expect(formatTime(45)).toBe('0:45');
    });

    it('formats exactly 1 minute', () => {
      expect(formatTime(60)).toBe('1:00');
    });

    it('formats minutes and seconds', () => {
      expect(formatTime(75)).toBe('1:15');
    });

    it('formats double digit minutes', () => {
      expect(formatTime(665)).toBe('11:05');
    });
  });

  describe('Edge Cases', () => {
    it('handles very large values', () => {
      expect(formatTime(3600)).toBe('60:00'); // 1 hour = 60 minutes
    });

    it('handles very long durations', () => {
      expect(formatTime(7200)).toBe('120:00'); // 2 hours
    });

    it('rounds down fractional seconds', () => {
      expect(formatTime(75.7)).toBe('1:15');
    });

    it('handles 59 seconds', () => {
      expect(formatTime(59)).toBe('0:59');
    });

    it('handles 59 minutes 59 seconds', () => {
      expect(formatTime(3599)).toBe('59:59');
    });
  });

  describe('Padding', () => {
    it('pads single digit seconds with zero', () => {
      expect(formatTime(61)).toBe('1:01');
      expect(formatTime(120)).toBe('2:00');
      expect(formatTime(129)).toBe('2:09');
    });

    it('does not pad double digit seconds', () => {
      expect(formatTime(130)).toBe('2:10');
      expect(formatTime(179)).toBe('2:59');
    });

    it('does not pad minutes', () => {
      expect(formatTime(600)).toBe('10:00');
      expect(formatTime(6000)).toBe('100:00');
    });
  });

  describe('Common Audio Durations', () => {
    it('formats 30 second audio', () => {
      expect(formatTime(30)).toBe('0:30');
    });

    it('formats 1 minute audio', () => {
      expect(formatTime(60)).toBe('1:00');
    });

    it('formats 2 minute 15 second audio', () => {
      expect(formatTime(135)).toBe('2:15');
    });

    it('formats 5 minute audio', () => {
      expect(formatTime(300)).toBe('5:00');
    });

    it('formats 10 minute 30 second audio', () => {
      expect(formatTime(630)).toBe('10:30');
    });
  });

  describe('Negative and Invalid Values', () => {
    it('handles negative values', () => {
      // Negative values produce unusual output due to floor operations
      // This documents current behavior rather than desired behavior
      const result = formatTime(-30);
      expect(result).toContain('-1');
    });

    it('handles NaN', () => {
      expect(formatTime(NaN)).toBe('NaN:NaN');
    });

    it('handles Infinity', () => {
      expect(formatTime(Infinity)).toBe('Infinity:NaN');
    });
  });
});
