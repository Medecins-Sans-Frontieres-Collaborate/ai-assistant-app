/**
 * Strict json_schema for quality assessments, shared by the translation
 * and document workflows. Built per-request so the criterion enums list
 * ONLY the requested subset — including 'custom:<uuid>' ids, which drop
 * straight into the enum (the server validates them against the caller's
 * submitted definitions; the server itself is stateless).
 */
export function buildAssessmentSchema(
  criterionIds: readonly string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      criteria: {
        type: 'array',
        description: 'One rating per requested criterion',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: [...criterionIds] },
            rating: {
              type: 'integer',
              enum: [1, 2, 3, 4, 5],
              description: '1 = unusable … 5 = publication-ready',
            },
            summary: { type: 'string' },
          },
          required: ['id', 'rating', 'summary'],
          additionalProperties: false,
        },
      },
      edits: {
        type: 'array',
        description:
          'Concrete proposed fixes (empty when nothing needs changing)',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string', enum: [...criterionIds] },
            before: {
              type: 'string',
              description:
                'EXACT verbatim substring of the assessed text, including enough surrounding words (3+) to be unique in the document',
            },
            after: { type: 'string' },
            reason: { type: 'string' },
            severity: { type: 'string', enum: ['minor', 'major'] },
          },
          required: ['criterion', 'before', 'after', 'reason', 'severity'],
          additionalProperties: false,
        },
      },
      overallSummary: { type: 'string' },
    },
    required: ['criteria', 'edits', 'overallSummary'],
    additionalProperties: false,
  };
}
