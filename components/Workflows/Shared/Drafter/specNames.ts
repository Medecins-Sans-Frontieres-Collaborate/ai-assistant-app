/**
 * A spec's name in the little room a chip or a column header has. The
 * first word carries it for every built-in ("Instagram caption" →
 * "Instagram", "WhatsApp broadcast" → "WhatsApp"); the full name stays
 * available as a tooltip wherever this is shown.
 */
export function shortSpecName(name: string): string {
  const first = name.trim().split(/\s+/u)[0] ?? name;
  return first.length > 14 ? `${first.slice(0, 13)}…` : first;
}
