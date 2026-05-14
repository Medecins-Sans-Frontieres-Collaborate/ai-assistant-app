import { ExtractionRecipe } from '@/types/extractionRecipe';

/**
 * Builds the system-prompt addendum for an extraction turn.
 *
 * The structured-output API enforces the SHAPE of the result; this prompt
 * tells the model what to LOOK FOR (per-recipe instructions) and how to
 * behave on ambiguous input (the shared rules block).
 *
 * Always called with a non-empty recipe list. Auto mode runs through a
 * two-stage flow in `StandardChatHandler` that synthesises a recipe via
 * `proposeFlatSchema` before reaching this function.
 */
export function composeExtractionPrompt(recipes: ExtractionRecipe[]): string {
  if (recipes.length === 0) {
    throw new Error(
      'composeExtractionPrompt requires at least one recipe; auto mode is handled upstream',
    );
  }

  const recipeBlocks = recipes
    .map((r, i) => {
      const fieldList = r.fields
        .map((f) => {
          const optional = f.required === false ? ' (optional)' : '';
          const description = f.description ? ` — ${f.description}` : '';
          const enumHint =
            f.type === 'enum' && f.enumValues?.length
              ? ` [one of: ${f.enumValues.join(', ')}]`
              : '';
          return `    • ${f.name} (${f.type}${enumHint})${optional}${description}`;
        })
        .join('\n');

      return [
        `${i + 1}. ${r.name}`,
        `   Instructions: ${r.instructions}`,
        '   Fields:',
        fieldList,
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are extracting structured data from the user-provided material and returning it as JSON.',
    '',
    `You will produce ${recipes.length} dataset${recipes.length === 1 ? '' : 's'}, in this order:`,
    '',
    recipeBlocks,
    '',
    'Rules:',
    '- Only include records the source material actually supports. Do not',
    '  invent records to fill space.',
    '- For optional fields with no supporting evidence, emit null.',
    '- Numeric fields must be numbers, not strings.',
    '- Date fields must be ISO-8601 YYYY-MM-DD strings.',
    '- If the material contains no records for a recipe, return an empty',
    '  array for that recipe key.',
  ].join('\n');
}
