import { ReportPeriod } from '@/lib/services/analytics/retention';

/** `YYYY-MM-DD` → a date at UTC midnight (periods carry no time zone). */
function utcDate(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00.000Z`);
}

function isWholeMonth(period: ReportPeriod): boolean {
  const from = utcDate(period.from);
  const to = utcDate(period.to);
  const lastDay = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return (
    from.getUTCDate() === 1 &&
    from.getUTCFullYear() === to.getUTCFullYear() &&
    from.getUTCMonth() === to.getUTCMonth() &&
    to.getUTCDate() === lastDay
  );
}

/** "July 2026", "26 Sept 2026" or "1 Jul 2026 – 15 Jul 2026". */
export function formatPeriod(
  period: ReportPeriod | null,
  locale: string,
): string | null {
  if (!period) return null;
  const day = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  if (period.from === period.to) return day.format(utcDate(period.from));
  if (isWholeMonth(period)) {
    return new Intl.DateTimeFormat(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(utcDate(period.from));
  }
  return `${day.format(utcDate(period.from))} – ${day.format(utcDate(period.to))}`;
}

export function formatDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(iso),
  );
}

/** The last path segment, or the given label for the root. */
export function folderLabel(path: string, rootLabel: string): string {
  if (path === '') return rootLabel;
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

export function folderDepth(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}
