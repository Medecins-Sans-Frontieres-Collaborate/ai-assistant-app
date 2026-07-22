/**
 * Strict json_schema definitions for the agentic translation phases.
 * Strict mode requires every property in `required` and
 * `additionalProperties: false` at every level.
 */

export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    trickyTerms: {
      type: 'array',
      description: 'Terms needing special handling in the target language',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          issue: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['term', 'issue', 'suggestion'],
        additionalProperties: false,
      },
    },
    ambiguities: {
      type: 'array',
      description: 'Passages with more than one plausible reading',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          readings: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'readings'],
        additionalProperties: false,
      },
    },
    register: {
      type: 'string',
      description: 'The register/tone the translation should keep',
    },
    notes: {
      type: 'string',
      description: 'Other considerations for the translator (empty if none)',
    },
  },
  required: ['trickyTerms', 'ambiguities', 'register', 'notes'],
  additionalProperties: false,
} as const;

// Assessment schema now shared across workflows; re-exported for
// existing call sites.
export { buildAssessmentSchema } from '../shared/assessmentSchema';

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'revise'],
      description:
        'approve when the translation is publication-ready; revise otherwise',
    },
    issues: {
      type: 'array',
      description: 'Problems found (empty when approving)',
      items: {
        type: 'object',
        properties: {
          excerpt: { type: 'string' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['minor', 'major'] },
          suggestion: { type: 'string' },
        },
        required: ['excerpt', 'problem', 'severity', 'suggestion'],
        additionalProperties: false,
      },
    },
    revisedText: {
      type: 'string',
      description:
        'The complete corrected translation. On approve, return the current translation unchanged.',
    },
  },
  required: ['verdict', 'issues', 'revisedText'],
  additionalProperties: false,
} as const;
