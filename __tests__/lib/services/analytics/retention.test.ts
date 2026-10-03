import { indexFolders } from '@/lib/services/analytics/access';
import {
  DELETE_GRACE_DAYS,
  effectiveRetentionMonths,
  expiryOf,
  isDeletable,
  isExpired,
  periodOfFileName,
} from '@/lib/services/analytics/retention';

import { folder } from './fixtures';

import { describe, expect, it } from 'vitest';

describe('periodOfFileName', () => {
  it('reads a range, a day and a month from the example file names', () => {
    expect(
      periodOfFileName('usage/ocba/ocba_report_2026-07-01_to_2026-07-31.xlsx'),
    ).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(
      periodOfFileName('raw/telemetry/2026/09/2026-09-26.parquet'),
    ).toEqual({ from: '2026-09-26', to: '2026-09-26' });
    expect(periodOfFileName('MS Azure rebilling_2026-07.xlsx')).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(
      periodOfFileName('emissions_report_2026-09_MSF-Germany.xlsx'),
    ).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('knows the length of February', () => {
    expect(periodOfFileName('report_2028-02.xlsx')?.to).toBe('2028-02-29');
    expect(periodOfFileName('report_2027-02.xlsx')?.to).toBe('2027-02-28');
  });

  it('reads the file name, not the year/month folders above it', () => {
    expect(periodOfFileName('archive/2019-01/summary.xlsx')).toBeNull();
  });

  it('returns null for no period, an impossible date, or a reversed range', () => {
    expect(periodOfFileName('notes.xlsx')).toBeNull();
    expect(periodOfFileName('report_2026-13.xlsx')).toBeNull();
    expect(periodOfFileName('report_2026-02-30.xlsx')).toBeNull();
    expect(periodOfFileName('x_2026-08-01_to_2026-07-01.xlsx')).toBeNull();
  });
});

describe('effectiveRetentionMonths', () => {
  it('defaults to 24 and takes the nearest ancestor that sets a value', () => {
    const folders = indexFolders([
      folder('rebilling', { retentionMonths: 84 }),
      folder('rebilling/drafts', { retentionMonths: 3 }),
      folder('usage'),
    ]);
    expect(effectiveRetentionMonths('usage/ocba', folders)).toBe(24);
    expect(effectiveRetentionMonths('rebilling/2026', folders)).toBe(84);
    expect(effectiveRetentionMonths('rebilling/drafts/x', folders)).toBe(3);
  });
});

describe('expiry', () => {
  const july = {
    path: 'rebilling/MS Azure rebilling_2026-07.xlsx',
    // Restated and re-delivered much later: must not restart the clock.
    lastModified: '2027-03-10T09:00:00.000Z',
  };

  it('counts from the END of the report period, not the delivery date', () => {
    expect(expiryOf(july, 24).toISOString()).toBe('2028-08-01T00:00:00.000Z');
  });

  it('keeps the file through the last day of the window', () => {
    const expiresAt = expiryOf(july, 24);
    expect(isExpired(expiresAt, new Date('2028-07-31T23:59:59.000Z'))).toBe(
      false,
    );
    expect(isExpired(expiresAt, new Date('2028-08-01T00:00:00.000Z'))).toBe(
      true,
    );
  });

  it('falls back to the delivery date when the name carries no period', () => {
    expect(
      expiryOf(
        { path: 'misc/notes.xlsx', lastModified: '2026-01-31T10:00:00.000Z' },
        1,
      ).toISOString(),
      // 31 Jan + 1 month clamps to the end of February.
    ).toBe('2026-02-28T10:00:00.000Z');
  });

  it('becomes deletable only after the grace period', () => {
    const expiresAt = expiryOf(july, 24);
    const day = 86_400_000;
    expect(
      isDeletable(
        expiresAt,
        new Date(expiresAt.getTime() + (DELETE_GRACE_DAYS - 1) * day),
      ),
    ).toBe(false);
    expect(
      isDeletable(
        expiresAt,
        new Date(expiresAt.getTime() + DELETE_GRACE_DAYS * day),
      ),
    ).toBe(true);
  });
});
