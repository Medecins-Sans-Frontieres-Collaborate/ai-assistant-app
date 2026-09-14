import type { FieldFill } from '@/types/formFill';

/**
 * Structural check for a caller-supplied fill (the ledger entry shape the
 * client sends back as context). Values are otherwise untrusted.
 */
export function isFieldFill(value: unknown): value is FieldFill {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return 'value' in f && Array.isArray(f.provenance);
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Copies the caller's current fills into a fresh map, keeping only keys
 * that name a field of the template being filled.
 *
 * The allow-list is the point (CodeQL js/remote-property-injection, alert
 * 466): the request body's `fields` object is caller-controlled, so its
 * keys must never be written to a plain object verbatim — `__proto__` /
 * `constructor` would land on the object's prototype chain. A null-
 * prototype target is defence in depth for the same reason.
 */
export function collectCallerFills(
  fields: unknown,
  knownFieldIds: ReadonlySet<string>,
): Record<string, FieldFill> {
  const fills: Record<string, FieldFill> = Object.create(null);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return fills;
  }
  for (const [id, fill] of Object.entries(fields as Record<string, unknown>)) {
    // Even a null-prototype object takes `__proto__` as an own key, and a
    // template author could name a field anything — refuse the names that
    // matter to the prototype chain unconditionally.
    if (FORBIDDEN_KEYS.has(id)) continue;
    if (knownFieldIds.has(id) && isFieldFill(fill)) fills[id] = fill;
  }
  return fills;
}
