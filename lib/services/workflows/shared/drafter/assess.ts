/**
 * Assessment: the same exact-span suggestions as a revision, but asked for
 * by criteria instead of by an instruction. Three criteria always apply;
 * organisation style and compliance guides add their own. Code-decidable
 * problems (length, an invented quote, an ungrounded number) are NOT asked
 * here: the deterministic checks already state those as facts.
 */
import { DRAFTER_CRITERIA, ProposedEdit } from '@/types/drafter';

export const CRITERION_RUBRIC: Record<
  (typeof DRAFTER_CRITERIA)[number],
  string
> = {
  faithful:
    'Says nothing the brief does not. Flag any claim, implication, ' +
    'emphasis or causal link that goes beyond the brief, and any place ' +
    'the key message is lost or distorted.',
  'human-first':
    'Leads with a person, not a statistic. Where the brief offers a ' +
    'quotation or testimony and the text opens on a number or an ' +
    'abstraction instead, suggest reordering or rewording so the human ' +
    'voice comes first.',
  voice:
    'Fits the voice and tone rules given, and the target. Flag jargon, ' +
    'hype, institutional phrasing and anything a reader of this target ' +
    'would find stiff or off.',
};

export function buildAssessSchema(
  criterionIds: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['edits'],
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion', 'segmentId', 'before', 'after', 'reason'],
          properties: {
            criterion: { type: 'string', enum: criterionIds },
            segmentId: { type: 'string' },
            before: {
              type: 'string',
              description:
                'Exact text to replace, copied character for character ' +
                'from that segment. As short as the change allows.',
            },
            after: { type: 'string' },
            reason: {
              type: 'string',
              description:
                'One short sentence naming the problem, in the language ' +
                'of the post.',
            },
          },
        },
      },
    },
  };
}

export interface RawAssessResponse {
  edits: Array<{
    criterion: string;
    segmentId: string;
    before: string;
    after: string;
    reason: string;
  }>;
}

export function buildAssessSystemPrompt(options: {
  specBlock: string;
  toneBlock: string;
  language: string;
  intentBlock: string;
  guideBlocks: string;
  guideRubric: string[];
}): string {
  const rubric = [
    ...DRAFTER_CRITERIA.map((id) => `- "${id}": ${CRITERION_RUBRIC[id]}`),
    ...options.guideRubric,
  ].join('\n');
  return `You review public communications for a humanitarian medical organisation before they are posted. You are given one version and the brief it was written from.

CRITERIA (use these exact ids in "criterion")
${rubric}

HOW TO ANSWER
- Return a list of edits. Each edit fixes ONE problem under ONE criterion by replacing an exact span. "before" must be copied character for character from the segment named in "segmentId".
- Only report real problems. A version that is fine returns no edits. Do not suggest changes of taste.
- Make the smallest edit that fixes the problem.

WHAT YOU MAY NOT CHANGE
- Text inside quotation marks: those are people's exact words.
- Any URL.
- Do not introduce any fact, number, date, place or name that is not in the brief.

${options.intentBlock}

Write "after" and "reason" in ${options.language}.

STRUCTURE FOR THIS TARGET (the edited text must still obey it)
${options.specBlock}${options.toneBlock}${options.guideBlocks ? `\n\n${options.guideBlocks}` : ''}`;
}

export function normalizeAssessResponse(
  raw: RawAssessResponse,
  allowed: Set<string>,
): ProposedEdit[] {
  return (Array.isArray(raw?.edits) ? raw.edits : [])
    .filter(
      (edit) =>
        edit &&
        typeof edit.segmentId === 'string' &&
        typeof edit.before === 'string' &&
        typeof edit.after === 'string' &&
        allowed.has(edit.criterion),
    )
    .map((edit) => ({
      criterion: edit.criterion,
      segmentId: edit.segmentId,
      before: edit.before,
      after: edit.after,
      reason: String(edit.reason ?? '').slice(0, 300),
    }));
}
