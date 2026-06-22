/**
 * Pretty-prints a tool-call `arguments` value for display. Foundry sends these
 * as a JSON string; we re-indent valid JSON and fall back to the raw string
 * when it isn't parseable. Returns null when there's nothing meaningful to show.
 */
export function formatToolArguments(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return null;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}
