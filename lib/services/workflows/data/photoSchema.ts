/**
 * Strict json_schema for photo → data inference: with no schema yet, the
 * model reads the photographed form/table and proposes the structure AND
 * the values. Values-array rows (like the transform schema) because
 * dynamic keys are impossible before columns exist. Client-safe.
 */
export function photoInferResponseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['record', 'table'],
        description:
          "'record' = the material is one filled form (each photo = one record); 'table' = it contains a table or repeated entries (each line = one row).",
      },
      columns: {
        type: 'array',
        description:
          'The inferred structure (field per form label / table column).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Field label as printed' },
            type: {
              type: 'string',
              enum: ['text', 'number', 'date', 'boolean'],
            },
            required: {
              type: 'boolean',
              description:
                'True when the form marks the field mandatory or it is clearly essential to the record.',
            },
          },
          required: ['name', 'type', 'required'],
          additionalProperties: false,
        },
      },
      rows: {
        type: 'array',
        description: 'Extracted records/rows.',
        items: {
          type: 'object',
          properties: {
            values: {
              type: 'array',
              description:
                'Cell values in column order, as strings ("" for empty/illegible); numbers plain, dates ISO 8601, booleans "true"/"false".',
              items: { type: 'string' },
            },
          },
          required: ['values'],
          additionalProperties: false,
        },
      },
      notes: {
        type: 'string',
        description:
          'Short caveats: illegible fields, assumptions, cropped content. "" when none.',
      },
    },
    required: ['kind', 'columns', 'rows', 'notes'],
    additionalProperties: false,
  };
}
