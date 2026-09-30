'use client';

/**
 * Display names for specs, shared with code that runs outside the workspace
 * (the rail's send module, the "To:" line). The workspace registers the list
 * it is showing; anything not registered falls back to the caller's default,
 * so an organisation's own channel is named properly everywhere.
 */
const names = new Map<string, string>();

export function rememberSpecNames(
  specs: ReadonlyArray<{ id: string; name: string }>,
): void {
  for (const spec of specs) names.set(spec.id, spec.name);
}

export function specNameOf(id: string, fallback?: string): string {
  return names.get(id) ?? fallback ?? id;
}
