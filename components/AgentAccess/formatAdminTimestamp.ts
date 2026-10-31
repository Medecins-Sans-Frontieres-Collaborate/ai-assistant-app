/**
 * A stored ISO timestamp as the admin's locale prints it ("17 Jul 2026,
 * 10:00"); the raw value when it is not a date. Rendered only after data
 * arrives on the client, so no hydration mismatch.
 */
export function formatAdminTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
