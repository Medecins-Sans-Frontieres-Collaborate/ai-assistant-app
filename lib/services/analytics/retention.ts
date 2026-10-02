/**
 * Retention for delivered files (design §4.4). Pure and client-importable.
 *
 * The clock is the REPORT PERIOD, not the delivery date: a July 2026 report
 * expires 24 months after the end of July 2026, and a restated file delivered
 * later for the same period does not restart it. A file whose name carries no
 * period falls back to the blob's last-modified time.
 */
import { FolderIndex } from '@/lib/services/analytics/access';
import { baseName, folderChain } from '@/lib/services/analytics/paths';
import {
  DEFAULT_RETENTION_MONTHS,
  DeliveredBlob,
} from '@/lib/services/analytics/types';

export interface ReportPeriod {
  /** Inclusive, `YYYY-MM-DD`. */
  from: string;
  to: string;
}

/**
 * Days an expired file stays in storage, visible to admins as "pending
 * deletion", before the sweep removes it.
 */
export const DELETE_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The period a file name states: `…_2026-07-01_to_2026-07-31…` (a range),
 * `2026-09-26…` (a day) or `…_2026-07…` (a month), tried in that order. Null
 * when the name carries none, or carries an impossible date.
 */
export function periodOfFileName(fileName: string): ReportPeriod | null {
  const name = baseName(fileName);

  const range = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(name);
  if (range) {
    const [y1, m1, d1, y2, m2, d2] = range.slice(1).map(Number);
    if (!isRealDate(y1, m1, d1) || !isRealDate(y2, m2, d2)) return null;
    const from = iso(y1, m1, d1);
    const to = iso(y2, m2, d2);
    return from <= to ? { from, to } : null;
  }

  const day = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(name);
  if (day) {
    const [y, m, d] = day.slice(1).map(Number);
    if (!isRealDate(y, m, d)) return null;
    return { from: iso(y, m, d), to: iso(y, m, d) };
  }

  const month = /(?<!\d)(\d{4})-(\d{2})(?![\d-])/.exec(name);
  if (month) {
    const [y, m] = month.slice(1).map(Number);
    if (m < 1 || m > 12) return null;
    return { from: iso(y, m, 1), to: iso(y, m, lastDayOfMonth(y, m)) };
  }

  return null;
}

/** The nearest ancestor's `retentionMonths`, else the platform default. */
export function effectiveRetentionMonths(
  folderPath: string,
  folders: FolderIndex,
): number {
  for (const path of folderChain(folderPath)) {
    const months = folders.get(path)?.retentionMonths;
    if (typeof months === 'number') return months;
  }
  return DEFAULT_RETENTION_MONTHS;
}

function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  // Clamp to the target month's length (31 Jan + 1 month → 28/29 Feb).
  result.setUTCDate(
    Math.min(
      day,
      lastDayOfMonth(result.getUTCFullYear(), result.getUTCMonth() + 1),
    ),
  );
  return result;
}

/**
 * When a file stops being shown: the end of its period (or its last-modified
 * time) plus the retention. The whole last day of the period counts.
 */
export function expiryOf(
  blob: Pick<DeliveredBlob, 'path' | 'lastModified'>,
  retentionMonths: number,
): Date {
  const period = periodOfFileName(blob.path);
  const anchor = period
    ? new Date(new Date(`${period.to}T00:00:00.000Z`).getTime() + DAY_MS)
    : new Date(blob.lastModified);
  return addMonthsUtc(anchor, retentionMonths);
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/** Past expiry AND past the grace window — the sweep may delete it. */
export function isDeletable(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime() + DELETE_GRACE_DAYS * DAY_MS;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
