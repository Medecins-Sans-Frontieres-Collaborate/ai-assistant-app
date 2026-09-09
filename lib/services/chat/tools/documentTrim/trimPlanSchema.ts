/**
 * The edit plan the Stage-1 planner produces and the Stage-2 sandbox script
 * applies mechanically. Kept strict (every property required,
 * additionalProperties: false) so structured output cannot drift.
 */

export interface TrimOperation {
  action: 'delete' | 'replace';
  /**
   * VERBATIM opening of the first affected paragraph (≥40 chars where the
   * paragraph allows), unique in the document. The executor matches by
   * normalized prefix, forward-only, in document order.
   */
  anchor: string;
  /** Consecutive body paragraphs consumed starting at the anchor. */
  paragraphCount: number;
  /** Empty for delete; condensed prose paragraphs for replace. */
  replacement: string[];
}

export interface TrimPlan {
  operations: TrimOperation[];
  /** One-sentence description of what was cut — shown to the user. */
  summary: string;
}

export const TRIM_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['delete', 'replace'] },
          anchor: {
            type: 'string',
            description:
              'Verbatim opening text (>=40 characters where possible) of the FIRST paragraph this operation affects, copied exactly from the source. Must be unique in the document. Operations must be listed in document order.',
          },
          paragraphCount: {
            type: 'integer',
            minimum: 1,
            description:
              'How many consecutive body paragraphs this operation consumes, starting at the anchor paragraph.',
          },
          replacement: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Empty array for delete. For replace: the condensed paragraphs that take the span’s place.',
          },
        },
        required: ['action', 'anchor', 'paragraphCount', 'replacement'],
        additionalProperties: false,
      },
    },
    summary: {
      type: 'string',
      description:
        'One sentence describing what was cut or condensed, for the user.',
    },
  },
  required: ['operations', 'summary'],
  additionalProperties: false,
};
