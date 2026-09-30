import {
  formatAnnouncementText,
  formatVariable,
} from '@/lib/utils/app/announcements/formatVariables';

import { describe, expect, it } from 'vitest';

const options = (timeZone: string, locale = 'en-GB') => ({
  locale,
  timeZone,
  localTimeTemplate: '{time} your time',
});

const range = {
  name: 'window',
  type: 'timeRange' as const,
  from: '2026-10-12T14:00:00.000Z',
  to: '2026-10-12T18:00:00.000Z',
};

describe('formatVariable', () => {
  it('shows UTC and the reader’s local time together', () => {
    const text = formatVariable(range, options('Europe/Paris'));
    expect(text).toContain('UTC');
    expect(text).toContain('14:00');
    expect(text).toContain('18:00');
    // Paris is UTC+2 on that date.
    expect(text).toContain('16:00');
    expect(text).toContain('20:00');
    expect(text).toContain('your time');
  });

  it('drops the parenthesis when the reader’s clock reads the same as UTC', () => {
    const text = formatVariable(range, options('UTC'));
    expect(text).toContain('UTC');
    expect(text).not.toContain('your time');
    expect(text).not.toContain('(');
  });

  it('carries the local DATE when the reader is on another calendar day', () => {
    const late = {
      name: 'start',
      type: 'instant' as const,
      at: '2026-10-12T22:00:00.000Z',
    };
    const dhaka = formatVariable(late, options('Asia/Dhaka'));
    expect(dhaka).toContain('12 Oct');
    expect(dhaka).toContain('13 Oct');
    // Same calendar day → the local clock alone is enough.
    const paris = formatVariable(
      { ...late, at: '2026-10-12T10:00:00.000Z' },
      options('Europe/Paris'),
    );
    expect(paris).toContain('12:00');
    expect(paris.match(/12 Oct/g)).toHaveLength(1);
  });

  it('renders a calendar date in UTC so it cannot slip a day far from Greenwich', () => {
    const day = {
      name: 'day',
      type: 'date' as const,
      on: '2026-10-12T00:00:00.000Z',
    };
    expect(formatVariable(day, options('America/Los_Angeles'))).toContain(
      '12 October 2026',
    );
  });

  it('never blanks a banner over an unknown locale or timezone', () => {
    expect(() =>
      formatVariable(range, options('Not/AZone', 'xx-invalid-locale')),
    ).not.toThrow();
  });
});

describe('formatAnnouncementText', () => {
  it('substitutes declared variables and leaves unknown placeholders untouched', () => {
    const text = formatAnnouncementText(
      'Down {window}, see {other}.',
      [range],
      options('UTC'),
    );
    expect(text).toContain('14:00');
    expect(text).toContain('{other}');
    expect(text).not.toContain('{window}');
  });
});
