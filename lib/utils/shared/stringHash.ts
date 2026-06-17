/**
 * Small, fast, deterministic 32-bit string hash (djb-style, multiplier 31).
 * Stable across sessions, so it's safe for picking stable colors, disambiguating
 * IDs, and similar UI-facing uses. Not cryptographic.
 */
export function stringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}
