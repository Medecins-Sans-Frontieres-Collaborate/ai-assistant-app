/**
 * Per-browser dismissal state for announcements.
 *
 * Keyed `<id>:<revision>` so "notify again" (a revision bump) re-shows a
 * message while a typo fix does not. Each entry carries the instant the
 * announcement stops being delivered: past it the entry is ignored on read
 * and dropped on the next write — the record expires with the announcement
 * and cannot grow without bound.
 *
 * localStorage can be unavailable (private mode, blocked site data): every
 * access is guarded, and the worst case is a dismissal that lasts only for
 * the session.
 */
const STORAGE_KEY = 'announcement-dismissals';

type Dismissals = Record<string, string>;

export function dismissalKey(id: string, revision: number): string {
  return `${id}:${revision}`;
}

function read(): Dismissals {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Dismissals)
      : {};
  } catch {
    return {};
  }
}

function write(dismissals: Dismissals): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissals));
  } catch {
    // Session-only dismissal; see the header.
  }
}

function liveEntries(stored: Dismissals, now: number): Dismissals {
  const live: Dismissals = {};
  for (const [key, endsAt] of Object.entries(stored)) {
    const time = Date.parse(endsAt);
    if (!Number.isNaN(time) && time > now) live[key] = endsAt;
  }
  return live;
}

/** Live dismissal keys. A pure read — safe to call while rendering. */
export function loadDismissals(now: number = Date.now()): Set<string> {
  return new Set(Object.keys(liveEntries(read(), now)));
}

/** Records a dismissal and drops every expired record in the same write. */
export function recordDismissal(
  id: string,
  revision: number,
  endsAt: string,
  now: number = Date.now(),
): void {
  write({
    ...liveEntries(read(), now),
    [dismissalKey(id, revision)]: endsAt,
  });
}
