/** Closed JSON-schema subset used by auxiliary runtime and compatibility probes. */

/** Validate structure, required fields, enum membership, and array bounds. */
export function matchesAuxiliarySchema(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    if (
      Array.isArray(schema.required) &&
      schema.required.some(
        (key) => typeof key !== 'string' || !Object.hasOwn(object, key),
      )
    )
      return false;
    return Object.entries(object).every(([key, entry]) =>
      Object.hasOwn(properties, key)
        ? matchesAuxiliarySchema(entry, properties[key])
        : schema.additionalProperties !== false,
    );
  }
  if (schema.type === 'array')
    return (
      Array.isArray(value) &&
      (typeof schema.maxItems !== 'number' ||
        value.length <= schema.maxItems) &&
      value.every((entry) =>
        matchesAuxiliarySchema(
          entry,
          (schema.items ?? {}) as Record<string, unknown>,
        ),
      )
    );
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number')
    return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'integer')
    return typeof value === 'number' && Number.isInteger(value);
  return true;
}
