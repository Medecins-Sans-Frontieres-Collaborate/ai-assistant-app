/**
 * Strict json_schema for the data-quality assessment. Data-specific
 * rather than a variant of the shared builder: edits anchor to cells by
 * stable row id (rid) + column id instead of text substrings, and carry
 * a kind ('cell' | 'deleteRow'), so the item shape is structurally
 * different from the text workflows'.
 */
export function buildDataAssessmentSchema(
  criterionIds: readonly string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      criteria: {
        type: 'array',
        description: 'One rating per requested criterion.',
        items: {
          type: 'object',
          properties: {
            criterionId: { type: 'string', enum: [...criterionIds] },
            rating: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: '1 = unusable … 5 = analysis-ready.',
            },
            summary: { type: 'string' },
          },
          required: ['criterionId', 'rating', 'summary'],
          additionalProperties: false,
        },
      },
      edits: {
        type: 'array',
        description: 'Granular proposed fixes, most important first.',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string', enum: [...criterionIds] },
            kind: {
              type: 'string',
              enum: ['cell', 'deleteRow'],
              description:
                "'cell' changes one cell value; 'deleteRow' removes a redundant row.",
            },
            rid: {
              type: 'string',
              description:
                'The __rid of the target row, echoed EXACTLY from the table data.',
            },
            columnId: {
              type: 'string',
              description:
                "Target column id for 'cell' fixes; empty string for 'deleteRow'.",
            },
            before: {
              type: 'string',
              description:
                "Current cell value exactly as printed in the table ('' for empty). For 'deleteRow': a short summary of the row.",
            },
            after: {
              type: 'string',
              description:
                "Proposed value ('' to clear the cell). '' for 'deleteRow'.",
            },
            reason: { type: 'string' },
            severity: { type: 'string', enum: ['minor', 'major'] },
          },
          required: [
            'criterion',
            'kind',
            'rid',
            'columnId',
            'before',
            'after',
            'reason',
            'severity',
          ],
          additionalProperties: false,
        },
      },
      overallSummary: { type: 'string' },
    },
    required: ['criteria', 'edits', 'overallSummary'],
    additionalProperties: false,
  };
}
