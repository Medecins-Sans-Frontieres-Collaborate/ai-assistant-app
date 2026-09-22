/**
 * Revision: one instruction, applied to one version, returned as exact-span
 * suggestions. Kind-agnostic; the structural rules come from the adapter's
 * `promptBlock`, the same as generation.
 *
 * The model proposes; `admissibleEdits` (core) decides. Nothing here trusts a
 * proposal because the model made it.
 */
import { GenerateRequest, ProposedEdit } from '@/types/drafter';

export const REVISE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['edits'],
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['segmentId', 'before', 'after', 'reason'],
        properties: {
          segmentId: { type: 'string' },
          before: {
            type: 'string',
            description:
              'Exact text to replace, copied character for character from ' +
              'that segment. As short as the change allows.',
          },
          after: { type: 'string', description: 'The replacement text.' },
          reason: {
            type: 'string',
            description: 'One short sentence, in the language of the post.',
          },
        },
      },
    },
  },
};

export interface RawReviseResponse {
  edits: Array<{
    segmentId: string;
    before: string;
    after: string;
    reason: string;
  }>;
}

type BriefInput = GenerateRequest['brief'];

export function buildReviseSystemPrompt(
  specBlock: string,
  toneBlock: string,
  language: string,
  intentBlock: string,
): string {
  return `You revise public communications for a humanitarian medical organisation. You are given the current text of one version and one instruction from its author.

HOW TO ANSWER
- Return a list of edits. Each edit replaces one exact span of the current text. "before" must be copied character for character from the segment named in "segmentId".
- Make the SMALLEST edits that carry out the instruction. Several small edits are better than one that rewrites a paragraph. Leave everything the instruction does not concern exactly as it is.
- If the instruction asks for nothing that applies to this text, return no edits.

WHAT YOU MAY NOT CHANGE
- Text inside quotation marks. Those are people's exact words. Never edit, shorten or move a quotation, and never add one.
- Any URL.
- Facts. Add no fact, number, date, place, name or claim that is not in the brief.

${intentBlock}

Write in ${language}.

STRUCTURE FOR THIS TARGET (the edited text must still obey it)
${specBlock}${toneBlock}`;
}

export function buildReviseUserPrompt(
  instruction: string,
  segments: Array<{ id: string; text: string }>,
  brief: BriefInput,
  onlySegmentId?: string,
): string {
  const lines: string[] = [`INSTRUCTION: ${instruction}`, ''];
  if (onlySegmentId) {
    lines.push(
      `Only segment "${onlySegmentId}" may be changed. The others are shown for context.`,
      '',
    );
  }
  lines.push('CURRENT TEXT');
  for (const segment of segments) {
    lines.push(`<segment id="${segment.id}">\n${segment.text}\n</segment>`);
  }
  lines.push(
    '',
    `BRIEF (the only source of facts)`,
    `Key message: ${brief.keyMessage}`,
  );
  if (brief.callToAction) lines.push(`Call to action: ${brief.callToAction}`);
  for (const item of brief.items) {
    lines.push(`- [${item.kind}] ${item.text}`);
  }
  return lines.join('\n');
}

export function normalizeReviseResponse(
  raw: RawReviseResponse,
): ProposedEdit[] {
  return (Array.isArray(raw?.edits) ? raw.edits : [])
    .filter(
      (edit) =>
        edit &&
        typeof edit.segmentId === 'string' &&
        typeof edit.before === 'string' &&
        typeof edit.after === 'string',
    )
    .map((edit) => ({
      segmentId: edit.segmentId,
      before: edit.before,
      after: edit.after,
      reason: String(edit.reason ?? '').slice(0, 300),
    }));
}

/** One over-limit segment, as the platform measures it. */
export interface Overage {
  segmentId: string;
  over: number;
}

/** A tighten request gets this many tries to come back fitting. */
export const MAX_TIGHTEN_ROUNDS = 3;

/**
 * The instruction for "make it fit", written from a measurement rather than
 * from the user: a model told "a bit shorter" trims a word, and a hard limit
 * needs a number. A margin is asked for, because cutting exactly the overage
 * lands one character short as often as not.
 */
export function buildTightenInstruction(
  overages: Overage[],
  previous?: { edits: ProposedEdit[]; stillOver: Overage[] },
): string {
  const lines = [
    'Make this text fit its hard character limit. The platform REJECTS a ' +
      'post that is over, so this is not a matter of style.',
    ...overages.map(
      (entry) =>
        `- Segment "${entry.segmentId}" is ${entry.over} characters over, ` +
        `measured the way the platform counts. Cut at least ` +
        `${entry.over + Math.max(10, Math.ceil(entry.over * 0.5))} from it.`,
    ),
    'Cut words, not meaning: remove filler, repetition and the least ' +
      'important detail; prefer deleting a clause to rewording it. Every ' +
      'edit must make its segment SHORTER. Do not touch segments that fit. ' +
      'You may not shorten a quotation or remove a link; if a quotation is ' +
      'what makes it too long, cut around it.',
  ];
  if (previous) {
    lines.push(
      '',
      'Your previous edits were not enough. With all of them applied:',
      ...previous.stillOver.map(
        (entry) =>
          `- Segment "${entry.segmentId}" is STILL ${entry.over} over.`,
      ),
      'Previous edits:',
      ...previous.edits.map((edit) => `- "${edit.before}" -> "${edit.after}"`),
      'Return the FULL list of edits again, against the ORIGINAL text ' +
        'below, with larger or additional cuts.',
    );
  }
  return lines.join('\n');
}
