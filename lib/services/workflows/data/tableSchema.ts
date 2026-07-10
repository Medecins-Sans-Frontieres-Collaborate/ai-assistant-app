import { DataColumn } from '@/types/workflow';

/**
 * Builds the strict json_schema for extracting/transforming rows matching
 * the current table's columns. Adapts the flat-field mapping idea from
 * `lib/utils/server/extraction/recipeToJsonSchema.ts` to the data
 * workflow's column model. Client-safe (no server imports) so the
 * workspace can reason about column shapes too.
 */

function columnValueSchema(column: DataColumn): Record<string, unknown> {
  switch (column.type) {
    case 'number':
      return { type: ['number', 'null'] };
    case 'boolean':
      return { type: ['boolean', 'null'] };
    case 'date':
      return {
        type: ['string', 'null'],
        description: 'ISO 8601 date (YYYY-MM-DD) when known',
      };
    default:
      return { type: ['string', 'null'] };
  }
}

/** Row object schema keyed by column id. */
export function columnsToRowSchema(
  columns: DataColumn[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const column of columns) {
    properties[column.id] = {
      ...columnValueSchema(column),
      description: column.name,
    };
  }
  return {
    type: 'object',
    properties,
    required: columns.map((c) => c.id),
    additionalProperties: false,
  };
}

export function extractionResponseSchema(
  columns: DataColumn[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      rows: { type: 'array', items: columnsToRowSchema(columns) },
    },
    required: ['rows'],
    additionalProperties: false,
  };
}

/**
 * Transform responses may add/rename columns, so the result carries its
 * own column list; row values are constrained per declared type by the
 * validator on apply (not by json_schema, which can't reference the
 * response's own columns).
 */
export function transformResponseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            type: {
              type: 'string',
              enum: ['text', 'number', 'date', 'boolean'],
            },
          },
          required: ['id', 'name', 'type'],
          additionalProperties: false,
        },
      },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          description: 'Row keyed by column id; values as JSON strings',
          properties: {
            values: {
              type: 'array',
              description:
                'Cell values in column order, as strings ("" for empty)',
              items: { type: 'string' },
            },
          },
          required: ['values'],
          additionalProperties: false,
        },
      },
      explanation: {
        type: 'string',
        description: 'One sentence describing what was done',
      },
    },
    required: ['columns', 'rows', 'explanation'],
    additionalProperties: false,
  };
}
