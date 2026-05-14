import {
  ExtractionRecipe,
  ExtractionResponseFormat,
  RecipeField,
} from '@/types/extractionRecipe';

/**
 * Maps a single `RecipeField` to a JSON Schema fragment.
 *
 * Type mapping:
 *  - text / number / boolean → JSON Schema primitives
 *  - date                    → string with `format: 'date'` (YYYY-MM-DD)
 *  - enum                    → string + `enum` array
 *  - list<text|number>       → array of the primitive
 */
function fieldToSchemaFragment(field: RecipeField): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (field.description) {
    base.description = field.description;
  }

  switch (field.type) {
    case 'text':
      return { ...base, type: 'string' };
    case 'number':
      return { ...base, type: 'number' };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'date':
      return { ...base, type: 'string', format: 'date' };
    case 'enum':
      return { ...base, type: 'string', enum: field.enumValues ?? [] };
    case 'list<text>':
      return { ...base, type: 'array', items: { type: 'string' } };
    case 'list<number>':
      return { ...base, type: 'array', items: { type: 'number' } };
    default: {
      const exhaustive: never = field.type;
      void exhaustive;
      return { ...base, type: 'string' };
    }
  }
}

/**
 * Per-recipe schema fragment: an array of objects shaped by the recipe's
 * fields.
 *
 * OpenAI strict mode requires `additionalProperties: false` and every
 * property listed in `properties` to also appear in `required`. We honour
 * that by listing all fields in `required` and modelling optional fields
 * as a nullable union (`type: ['string', 'null']`) — strict mode supports
 * nullable types but not omitted-keys.
 */
export function recipeToArraySchema(
  recipe: ExtractionRecipe,
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const field of recipe.fields) {
    const fragment = fieldToSchemaFragment(field);

    if (field.required === false) {
      const currentType = fragment.type;
      if (typeof currentType === 'string') {
        fragment.type = [currentType, 'null'];
      } else if (Array.isArray(currentType) && !currentType.includes('null')) {
        fragment.type = [...currentType, 'null'];
      }
    }

    properties[field.name] = fragment;
    required.push(field.name);
  }

  return {
    type: 'array',
    description: recipe.instructions || recipe.description,
    items: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/**
 * Slugs a recipe name into a stable JSON key. Two recipes whose names
 * collapse to the same slug get suffixed (`_2`, `_3`, ...) so the composite
 * schema's `properties` keys stay unique.
 */
function recipeNameToKey(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'recipe';

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix++;
  const key = `${base}_${suffix}`;
  taken.add(key);
  return key;
}

/**
 * Composes one OpenAI-compatible JSON Schema covering all selected recipes.
 *
 * The top-level object has one key per recipe (slugged from `recipe.name`),
 * each pointing to the recipe's array-of-records schema. The renderer uses
 * `keyByRecipeId` to match output keys back to recipe ids.
 */
export function recipesToResponseFormat(
  recipes: ExtractionRecipe[],
  schemaName = 'extraction_result',
): Required<Pick<ExtractionResponseFormat, 'keyByRecipeId'>> &
  ExtractionResponseFormat {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const taken = new Set<string>();
  const keyByRecipeId: Record<string, string> = {};

  for (const recipe of recipes) {
    const key = recipeNameToKey(recipe.name, taken);
    properties[key] = recipeToArraySchema(recipe);
    required.push(key);
    keyByRecipeId[recipe.id] = key;
  }

  return {
    name: schemaName,
    schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    strict: true,
    recipeOrder: recipes.map((r) => r.id),
    keyByRecipeId,
  };
}
