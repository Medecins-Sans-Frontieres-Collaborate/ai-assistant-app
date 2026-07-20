/**
 * The custom-criterion id convention, shared by every workflow that lets
 * users define their own quality criteria. Ids are namespaced so a custom
 * criterion can never collide with a built-in one, which is what lets both
 * kinds travel through the same request field, prompt list, and schema enum.
 */

const CUSTOM_PREFIX = 'custom:';

/**
 * Deliberately NOT a `value is string` type predicate: callers pass an
 * already-`string` id, and narrowing the negative branch to `never` would
 * break the common `if (!isCustomCriterionId(id)) { ...use id... }` shape.
 */
export function isCustomCriterionId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(CUSTOM_PREFIX);
}

export function customCriterionId(uuid: string): string {
  return `${CUSTOM_PREFIX}${uuid}`;
}

/** The definition sent alongside a request so the server can build a rubric. */
export interface CustomCriterionDefinition {
  id: string;
  name: string;
  rubric: string;
}

export const MAX_CRITERION_NAME_CHARS = 100;
export const MAX_CRITERION_RUBRIC_CHARS = 2000;

/**
 * Keeps only well-formed definitions, keyed by id.
 *
 * Routes use this as the first half of a two-phase check: build the map,
 * then require every requested custom id to have an entry. A criterion
 * whose definition is missing or malformed is therefore rejected outright
 * rather than reaching the model as an empty rubric line.
 */
export function collectCustomCriteria(
  definitions: readonly Partial<CustomCriterionDefinition>[] | undefined,
): Map<string, { name: string; rubric: string }> {
  const byId = new Map<string, { name: string; rubric: string }>();
  for (const def of definitions ?? []) {
    if (
      def &&
      isCustomCriterionId(def.id) &&
      typeof def.name === 'string' &&
      def.name.trim() !== '' &&
      def.name.length <= MAX_CRITERION_NAME_CHARS &&
      typeof def.rubric === 'string' &&
      def.rubric.trim() !== '' &&
      def.rubric.length <= MAX_CRITERION_RUBRIC_CHARS
    ) {
      byId.set(def.id as string, { name: def.name, rubric: def.rubric });
    }
  }
  return byId;
}

/**
 * The prompt line for one requested criterion: the built-in's own rubric,
 * or `name: rubric` for a custom one. Returns null when neither is known,
 * so callers drop it rather than emitting a blank bullet.
 */
export function criterionRubricLine(
  id: string,
  builtinDescription: string | undefined,
  customById: Map<string, { name: string; rubric: string }>,
): string | null {
  if (builtinDescription) return builtinDescription;
  const custom = customById.get(id);
  if (!custom) return null;
  return `${custom.name}: ${custom.rubric}`;
}
