/**
 * Strict json_schema for the document workflow's agentic pre-assessment
 * (register/tone/audience/purpose/spelling-variety profile).
 */
export const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    docType: {
      type: 'string',
      description:
        'What kind of document this is (e.g. situation report, donor letter, meeting minutes)',
    },
    audience: {
      type: 'string',
      description: 'The apparent intended readership',
    },
    purpose: {
      type: 'string',
      description: 'What the document is trying to achieve',
    },
    register: {
      type: 'string',
      description: 'Formality level (e.g. formal, neutral, conversational)',
    },
    toneSummary: {
      type: 'string',
      description: 'One sentence characterizing the voice/tone',
    },
    language: {
      type: 'string',
      description:
        'The language the document is written in (English name, e.g. "French", "Arabic")',
    },
    conventionNotes: {
      type: 'string',
      description:
        'Orthographic/regional conventions observed, including any inconsistencies (e.g. "UK English throughout", "mixes en-US and en-GB spellings", "Brazilian Portuguese orthography"); empty when nothing notable',
    },
    notes: {
      type: 'string',
      description: 'Other observations useful to an editor (empty when none)',
    },
  },
  required: [
    'docType',
    'audience',
    'purpose',
    'register',
    'toneSummary',
    'language',
    'conventionNotes',
    'notes',
  ],
  additionalProperties: false,
} as const;
