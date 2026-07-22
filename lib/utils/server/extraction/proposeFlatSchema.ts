import { FieldType, RecipeField } from '@/types/extractionRecipe';

import OpenAI from 'openai';

/**
 * Shared infrastructure for *proposing* a flat extraction schema via
 * structured outputs. Used by:
 *
 *  - The auto-mode branch of `StandardChatHandler.executeExtraction`, where
 *    the source material is the user's chat messages and the proposed
 *    schema becomes a synthetic recipe for Stage 2.
 *  - The `/api/extraction/suggest-schema` endpoint, where the source is
 *    the user's free-text instructions (plus optional sample / existing
 *    fields) and the proposal pre-fills the Settings recipe editor.
 *
 * Flat means: a single table of records, primitive fields only, no nested
 * arrays/objects. The propose call rejects `list<text>` / `list<number>`
 * — those types are valid for user-authored recipes, but auto-mode is
 * intentionally simpler so the result is reliably downloadable as
 * CSV/TSV.
 */

const METRIC_TYPES: ReadonlyArray<FieldType> = ['number', 'date', 'enum'];

/**
 * Primitives-only field set — what auto-mode requires so the resulting
 * extraction is reliably exportable to CSV/TSV. Excludes `list<*>` types.
 */
export const FLAT_FIELD_TYPES: ReadonlyArray<FieldType> = [
  'text',
  'number',
  'date',
  'boolean',
  'enum',
];

/**
 * Full field set — every type a user-authored recipe can use. Includes
 * `list<*>`. Use this when calling the proposer from the Settings
 * "Suggest with AI" button.
 */
export const ALL_FIELD_TYPES: ReadonlyArray<FieldType> = [
  'text',
  'number',
  'date',
  'boolean',
  'enum',
  'list<text>',
  'list<number>',
];

function buildSchema(allowedTypes: ReadonlyArray<FieldType>) {
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description:
          'Proposed fields for the recipe. snake_case names. Concrete types only.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'snake_case identifier, starts with a letter; will be used verbatim as the JSON key',
            },
            type: {
              type: 'string',
              enum: allowedTypes as unknown as string[],
              description: 'Field type',
            },
            description: {
              type: ['string', 'null'],
              description:
                'Short hint (one phrase) for the extractor; null if not useful',
            },
            required: {
              type: 'boolean',
              description:
                'True only when every record will reliably contain this field',
            },
            enumValues: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description:
                'Allowed values when type=enum; null for every other type',
            },
          },
          required: ['name', 'type', 'description', 'required', 'enumValues'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  } as const;
}

function buildSystemPrompt(
  allowedTypes: ReadonlyArray<FieldType>,
  requireMetric: boolean,
): string {
  const allowsLists = allowedTypes.some((t) => t.startsWith('list<'));
  const typeList = allowedTypes.join(' / ');

  const lines: string[] = [
    'You design typed data extraction schemas. Each schema describes ONE table where rows are records and columns are fields.',
    'Return the result as a JSON object matching the response schema.',
    'Rules:',
    '- 3 to 8 fields, unless the material clearly demands more. snake_case names.',
    `- Concrete types only, from this set: ${typeList}.`,
  ];
  if (!allowsLists) {
    lines.push(
      '- No nested arrays or objects. No list<text> / list<number> / list<object> — they are not valid here.',
    );
  }
  lines.push(
    '- Use enum only when allowed values are bounded and named.',
    '- Mark a field required only when every record will reliably contain it.',
    '- Descriptions are short, useful hints — they tell the extractor what to look for.',
    '- Always emit `description` and `enumValues` keys; use null when they do not apply.',
  );
  if (requireMetric) {
    lines.push(
      '- At least one field must be a number, date, or enum — the analytical column that lets the data be aggregated or filtered.',
    );
  }
  return lines.join('\n');
}

export interface ProposeFlatSchemaOptions {
  /** When true (default), enforces at least one number/date/enum field. */
  requireMetric?: boolean;
  /** OpenAI model id (default 'gpt-5-mini'). */
  model?: string;
  /**
   * Field types the model is allowed to emit. Defaults to `FLAT_FIELD_TYPES`
   * (primitives only). Pass `ALL_FIELD_TYPES` for user-authored recipe
   * suggestions where lists are valid.
   */
  allowedTypes?: ReadonlyArray<FieldType>;
}

interface RawField {
  name?: unknown;
  type?: unknown;
  description?: unknown;
  required?: unknown;
  enumValues?: unknown;
}

/**
 * Proposes a flat schema given a list of user-prompt fragments. Each
 * fragment is joined with a blank line. Callers compose fragments
 * appropriate to their context (raw source text, user instructions,
 * existing fields, sample material).
 */
export async function proposeFlatSchema(
  openAIClient: OpenAI,
  userPromptParts: string[],
  options: ProposeFlatSchemaOptions = {},
): Promise<RecipeField[]> {
  const requireMetric = options.requireMetric !== false;
  const model = options.model ?? 'gpt-5-mini';
  const allowedTypes = options.allowedTypes ?? FLAT_FIELD_TYPES;
  const systemPrompt = buildSystemPrompt(allowedTypes, requireMetric);
  const schema = buildSchema(allowedTypes);

  const runOnce = async (extraNudge?: string): Promise<RecipeField[]> => {
    const userContent = [
      ...userPromptParts,
      ...(extraNudge ? ['', extraNudge] : []),
    ].join('\n\n');

    const completion = await openAIClient.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'flat_schema_proposal',
          strict: true,
          schema: schema as unknown as Record<string, unknown>,
        },
      },
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    let payload: { fields?: unknown };
    try {
      payload = JSON.parse(raw) as { fields?: unknown };
    } catch {
      throw new Error('Model returned malformed JSON for schema proposal');
    }

    if (!Array.isArray(payload.fields)) {
      throw new Error('Schema proposal missing fields array');
    }

    return normaliseFields(payload.fields as RawField[], allowedTypes);
  };

  const initial = await runOnce();
  if (!requireMetric || hasMetric(initial)) {
    console.log(
      `[proposeFlatSchema] ${initial.length} fields proposed${
        requireMetric ? ` (metric: ${firstMetric(initial)?.name ?? 'n/a'})` : ''
      }`,
    );
    return initial;
  }

  // Retry once with an explicit nudge. The model often does the right
  // thing on the second pass when the constraint is named directly.
  console.warn(
    '[proposeFlatSchema] No metric column on first pass; retrying with nudge',
  );
  const retried = await runOnce(
    'Your previous response had no number, date, or enum field. Include at least one such field — it is the analytical column the user needs.',
  );
  if (hasMetric(retried)) {
    console.log(
      `[proposeFlatSchema] ${retried.length} fields after retry (metric: ${firstMetric(retried)?.name ?? 'n/a'})`,
    );
    return retried;
  }

  // Last resort: append a synthetic row_index so downstream extraction
  // still has a measurable column. Better to ship a degraded schema than
  // crash the user's turn.
  console.warn(
    '[proposeFlatSchema] Retry still missing metric; appending synthetic row_index',
  );
  return [
    ...retried,
    {
      id: `field_${Date.now()}_idx`,
      name: 'row_index',
      type: 'number',
      description:
        'Sequential index added because no measurable column was proposed',
      required: false,
    },
  ];
}

function hasMetric(fields: RecipeField[]): boolean {
  return fields.some((f) =>
    (METRIC_TYPES as ReadonlyArray<string>).includes(f.type),
  );
}

function firstMetric(fields: RecipeField[]): RecipeField | undefined {
  return fields.find((f) =>
    (METRIC_TYPES as ReadonlyArray<string>).includes(f.type),
  );
}

function normaliseFields(
  raw: RawField[],
  allowedTypes: ReadonlyArray<FieldType>,
): RecipeField[] {
  return raw
    .filter((f) => typeof f?.name === 'string' && typeof f?.type === 'string')
    .map((f, idx): RecipeField => {
      const type = f.type as FieldType;
      const enumValues =
        Array.isArray(f.enumValues) && f.enumValues.length > 0
          ? (f.enumValues as string[])
          : undefined;
      const description =
        typeof f.description === 'string' && f.description.length > 0
          ? f.description
          : undefined;
      const required = f.required !== false;
      return {
        id: `field_${Date.now()}_${idx}`,
        name: String(f.name),
        type,
        description,
        required,
        enumValues,
      };
    })
    .filter((f) => (allowedTypes as ReadonlyArray<string>).includes(f.type));
}
