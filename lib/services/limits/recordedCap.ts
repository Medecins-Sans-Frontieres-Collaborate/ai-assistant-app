/**
 * The cap a usage document records next to a counter (`UsageDoc.caps`), so
 * the daily usage summary can say how close each person came to THEIR cap
 * and which rule set it. Pure; kept apart from usageStore so the many tests
 * that mock the store do not have to re-export it.
 */
/** A cap as the usage document stores it; see `UsageDoc.caps`. */
export interface RecordedCap {
  limit: number;
  /** Override id, or the layer name ('global', 'catalog') that set the cap. */
  rule: string;
}

/**
 * The cap to record for a resolved, metered cell.
 *
 * @param cell - A resolved cell whose value is a number (a metered cell).
 */
export function capOf(cell: {
  value: unknown;
  source: string;
  overrideId?: string;
}): RecordedCap | undefined {
  if (typeof cell.value !== 'number') return undefined;
  return { limit: cell.value, rule: cell.overrideId ?? cell.source };
}
