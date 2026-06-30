/**
 * Sensitive context screening list.
 */

export const SENSITIVE_COUNTRIES: Set<string> = new Set([
  'Afghanistan',
  'Central African Republic',
  'Democratic Republic of the Congo',
  'Iran',
  'Iraq',
  'Libya',
  'Mali',
  'Myanmar',
  'North Korea',
  'Russia',
  'Somalia',
  'South Sudan',
  'Sudan',
  'Syria',
  'Ukraine',
  'Venezuela',
  'Yemen',
]);

export function isSensitive(country: string): boolean {
  return SENSITIVE_COUNTRIES.has(country.trim());
}
