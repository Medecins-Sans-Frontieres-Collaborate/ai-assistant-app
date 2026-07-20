import {
  recipeToArraySchema,
  recipesToResponseFormat,
} from '@/lib/utils/server/extraction/recipeToJsonSchema';

import { ExtractionRecipe, RecipeField } from '@/types/extractionRecipe';

import { describe, expect, it } from 'vitest';

const field = (
  name: string,
  overrides: Partial<RecipeField> = {},
): RecipeField => ({
  id: name,
  name,
  type: 'text',
  ...overrides,
});

const recipe = (
  name: string,
  fields: RecipeField[],
  overrides: Partial<ExtractionRecipe> = {},
): ExtractionRecipe => ({
  id: `id-${name}`,
  name,
  instructions: '',
  fields,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

type ItemsSchema = {
  items: {
    properties: Record<
      string,
      { type: unknown; enum?: unknown; items?: object }
    >;
    required: string[];
    additionalProperties: boolean;
  };
  description?: string;
};

describe('recipeToArraySchema', () => {
  it('maps each field type to its JSON Schema fragment', () => {
    // All required, so this isolates type mapping from the nullable-union
    // widening that optionality applies (covered separately below).
    const schema = recipeToArraySchema(
      recipe('r', [
        field('a', { type: 'text', required: true }),
        field('b', { type: 'number', required: true }),
        field('c', { type: 'boolean', required: true }),
        field('d', { type: 'date', required: true }),
        field('e', { type: 'enum', enumValues: ['x', 'y'], required: true }),
        field('f', { type: 'list<text>', required: true }),
        field('g', { type: 'list<number>', required: true }),
      ]),
    ) as unknown as ItemsSchema;

    const props = schema.items.properties;
    expect(props.a.type).toBe('string');
    expect(props.b.type).toBe('number');
    expect(props.c.type).toBe('boolean');
    expect(props.d).toMatchObject({ type: 'string', format: 'date' });
    expect(props.e).toMatchObject({ type: 'string', enum: ['x', 'y'] });
    expect(props.f).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(props.g).toMatchObject({ type: 'array', items: { type: 'number' } });
  });

  it('treats an omitted `required` as optional (nullable)', () => {
    // Polarity guard. Recipes once defaulted `required` to true; since the
    // shared-structure move (settings v41) absent means optional, and the
    // migration stamps `required: true` on every legacy field so no existing
    // recipe reaches here with an ambiguous flag.
    const schema = recipeToArraySchema(
      recipe('r', [field('a')]),
    ) as unknown as ItemsSchema;

    expect(schema.items.properties.a.type).toEqual(['string', 'null']);
  });

  it('keeps only explicitly required fields non-nullable', () => {
    const schema = recipeToArraySchema(
      recipe('r', [
        field('a', { required: false }),
        field('b', { required: true }),
        field('c', { type: 'list<text>', required: false }),
        field('d', { type: 'list<number>', required: true }),
      ]),
    ) as unknown as ItemsSchema;

    expect(schema.items.properties.a.type).toEqual(['string', 'null']);
    expect(schema.items.properties.b.type).toBe('string');
    expect(schema.items.properties.c.type).toEqual(['array', 'null']);
    expect(schema.items.properties.d.type).toBe('array');
  });

  it('lists every field in `required` regardless of optionality', () => {
    // OpenAI strict mode has no notion of omitted keys — optionality is
    // expressed by the nullable union above, never by shrinking `required`.
    const schema = recipeToArraySchema(
      recipe('r', [field('a', { required: false }), field('b')]),
    ) as unknown as ItemsSchema;

    expect(schema.items.required).toEqual(['a', 'b']);
    expect(schema.items.additionalProperties).toBe(false);
  });

  it('prefers instructions over description for the array description', () => {
    const withBoth = recipeToArraySchema(
      recipe('r', [field('a')], {
        instructions: 'find the invoices',
        description: 'ignored',
      }),
    ) as unknown as ItemsSchema;
    expect(withBoth.description).toBe('find the invoices');

    const withoutInstructions = recipeToArraySchema(
      recipe('r', [field('a')], { instructions: '', description: 'fallback' }),
    ) as unknown as ItemsSchema;
    expect(withoutInstructions.description).toBe('fallback');
  });

  it('carries a field description onto its fragment', () => {
    const schema = recipeToArraySchema(
      recipe('r', [field('a', { description: 'the title' })]),
    ) as unknown as ItemsSchema;

    expect(schema.items.properties.a).toMatchObject({
      description: 'the title',
    });
  });
});

describe('recipesToResponseFormat', () => {
  it('slugs recipe names into keys and maps them back by recipe id', () => {
    const format = recipesToResponseFormat([
      recipe('Invoice Lines', [field('a')]),
      recipe('Contact Info!', [field('b')]),
    ]);

    expect(format.keyByRecipeId).toEqual({
      'id-Invoice Lines': 'invoice_lines',
      'id-Contact Info!': 'contact_info',
    });
    expect(format.recipeOrder).toEqual([
      'id-Invoice Lines',
      'id-Contact Info!',
    ]);
    expect(format.strict).toBe(true);
    expect(format.name).toBe('extraction_result');
  });

  it('suffixes colliding slugs so composite keys stay unique', () => {
    const format = recipesToResponseFormat([
      recipe('Line Items', [field('a')]),
      recipe('line-items', [field('b')]),
      recipe('LINE  ITEMS', [field('c')]),
    ]);

    expect(Object.values(format.keyByRecipeId)).toEqual([
      'line_items',
      'line_items_2',
      'line_items_3',
    ]);
  });

  it('falls back to a stable key when a name slugs to nothing', () => {
    const format = recipesToResponseFormat([recipe('!!!', [field('a')])]);
    expect(Object.values(format.keyByRecipeId)).toEqual(['recipe']);
  });

  it('requires every recipe key at the top level', () => {
    const format = recipesToResponseFormat([
      recipe('One', [field('a')]),
      recipe('Two', [field('b')]),
    ]);
    const schema = format.schema as {
      required: string[];
      additionalProperties: boolean;
    };

    expect(schema.required).toEqual(['one', 'two']);
    expect(schema.additionalProperties).toBe(false);
  });
});
