import {
  buildAssessSchema,
  buildAssessSystemPrompt,
  normalizeAssessResponse,
} from '@/lib/services/workflows/shared/drafter/assess';

import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  landEdits,
  pendingEdits,
} from '@/lib/utils/shared/drafter/core/revisions';
import { emptyVersion } from '@/lib/utils/shared/drafter/core/versions';

import { DRAFTER_CRITERIA } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

describe('assessment', () => {
  const criterionIds = [...DRAFTER_CRITERIA, 'guide:house-style'];

  it('lets the model answer only under the criteria it was given', () => {
    const schema = buildAssessSchema(criterionIds) as {
      properties: {
        edits: { items: { properties: { criterion: { enum: string[] } } } };
      };
    };
    expect(schema.properties.edits.items.properties.criterion.enum).toEqual(
      criterionIds,
    );
  });

  it('drops suggestions filed under a criterion that was never asked', () => {
    const edits = normalizeAssessResponse(
      {
        edits: [
          {
            criterion: 'voice',
            segmentId: 's1',
            before: 'utilise',
            after: 'use',
            reason: 'Plainer',
          },
          {
            criterion: 'guide:someone-elses',
            segmentId: 's1',
            before: 'a',
            after: 'b',
            reason: '',
          },
          {
            criterion: 'taste',
            segmentId: 's1',
            before: 'a',
            after: 'b',
            reason: '',
          },
        ],
      },
      new Set(criterionIds),
    );
    expect(edits.map((edit) => edit.criterion)).toEqual(['voice']);
  });

  it('survives a malformed response', () => {
    expect(
      normalizeAssessResponse(
        { edits: null } as unknown as Parameters<
          typeof normalizeAssessResponse
        >[0],
        new Set(criterionIds),
      ),
    ).toEqual([]);
  });

  it('carries the criterion onto the landed suggestion', () => {
    const version = {
      ...emptyVersion('x'),
      segments: [
        { id: 's1', text: 'Our teams utilise clinics.', usedItemIds: [] },
      ],
    };
    const landed = landEdits(
      version,
      [
        {
          criterion: 'voice',
          segmentId: 's1',
          before: 'utilise',
          after: 'use',
          reason: 'Plainer',
        },
      ],
      emptyBrief(),
      ['e1'],
      '',
    );
    expect(pendingEdits(landed)[0].criterion).toBe('voice');
  });

  it('states the rubric, the guide lines and what may not be touched', () => {
    const prompt = buildAssessSystemPrompt({
      specBlock: 'Channel: X.',
      toneBlock: '',
      language: 'French',
      intentBlock: 'PURPOSE\n- These posts inform.',
      guideBlocks: 'STYLE GUIDE ("House style")',
      guideRubric: ['- "guide:house-style": House style (style guide)'],
    });
    for (const id of DRAFTER_CRITERIA) expect(prompt).toContain(`"${id}"`);
    expect(prompt).toContain('"guide:house-style"');
    expect(prompt).toContain('Text inside quotation marks');
    expect(prompt).toContain('A version that is fine returns no edits');
    expect(prompt).toContain('in French');
  });
});
