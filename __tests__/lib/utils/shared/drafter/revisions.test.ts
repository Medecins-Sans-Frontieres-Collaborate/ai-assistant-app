import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  acceptAllEdits,
  acceptEdit,
  admissibleEdits,
  discardPendingEdits,
  landEdits,
  pendingEdits,
  rejectEdit,
} from '@/lib/utils/shared/drafter/core/revisions';
import {
  approvalStatus,
  approveVersion,
  emptyVersion,
} from '@/lib/utils/shared/drafter/core/versions';

import { Brief, ProposedEdit, Version } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';
const LINK = 'https://example.org/statement';

const brief: Brief = {
  ...emptyBrief(),
  language: 'English',
  links: [{ role: 'article', label: 'Statement', url: LINK }],
  items: [
    {
      id: 'q1',
      kind: 'quote',
      text: 'We had no clean water for eleven days',
      provenance: [],
      verified: 'verbatim',
      decision: 'included',
    },
  ],
};

function version(): Version {
  return {
    ...emptyVersion('x'),
    segments: [
      {
        id: 's1',
        text: 'Our teams utilise mobile clinics. “We had no clean water for eleven days” said a nurse.',
        usedItemIds: ['q1'],
      },
      {
        id: 's2',
        text: `Read the full statement:\n\n${LINK}`,
        usedItemIds: [],
      },
    ],
  };
}

function proposal(partial: Partial<ProposedEdit>): ProposedEdit {
  return {
    segmentId: 's1',
    before: 'utilise',
    after: 'use',
    reason: 'Plainer word',
    ...partial,
  };
}

describe('admissible edits', () => {
  const segments = version().segments;

  it('keeps an edit whose words are really there', () => {
    expect(admissibleEdits([proposal({})], segments, brief)).toHaveLength(1);
  });

  it('drops edits that are absent, empty, no-ops or out of scope', () => {
    const kept = admissibleEdits(
      [
        proposal({ before: 'not in the text' }),
        proposal({ before: '' }),
        proposal({ after: 'utilise' }),
        proposal({ segmentId: 'ghost' }),
      ],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
    expect(admissibleEdits([proposal({})], segments, brief, 's2')).toEqual([]);
  });

  it('never lets a suggestion reword a quotation from the brief', () => {
    const kept = admissibleEdits(
      [proposal({ before: 'no clean water', after: 'no safe water' })],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
  });

  it('never lets a suggestion touch a link the brief carries', () => {
    const kept = admissibleEdits(
      [proposal({ segmentId: 's2', before: LINK, after: 'example.org' })],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
  });

  it('keeps only the first of two suggestions over the same words', () => {
    const kept = admissibleEdits(
      [
        proposal({ before: 'utilise mobile', after: 'use mobile' }),
        proposal({ before: 'mobile clinics', after: 'clinics' }),
      ],
      segments,
      brief,
    );
    expect(kept.map((e) => e.before)).toEqual(['utilise mobile']);
  });
});

describe('suggestions', () => {
  it('lands as pending, anchored, and leaves the text alone', () => {
    const landed = landEdits(
      version(),
      [proposal({})],
      brief,
      ['e1'],
      'plainer',
    );
    expect(landed.segments).toEqual(version().segments);
    expect(pendingEdits(landed)).toEqual([
      expect.objectContaining({
        id: 'e1',
        segmentId: 's1',
        status: 'pending',
        instruction: 'plainer',
        anchorStart: 10,
      }),
    ]);
  });

  it('accepting changes the text, and an approval lapses because of it', () => {
    const approved = approveVersion(version(), NOW);
    const landed = landEdits(
      approved,
      [proposal({})],
      brief,
      ['e1'],
      'plainer',
    );
    expect(approvalStatus(landed)).toBe('approved');
    const accepted = acceptEdit(landed, 'e1', NOW);
    expect(accepted.segments[0].text).toContain(
      'Our teams use mobile clinics.',
    );
    expect(accepted.edits?.[0].status).toBe('accepted');
    expect(approvalStatus(accepted)).toBe('changed');
  });

  it('rejecting leaves the text and the approval as they were', () => {
    const approved = approveVersion(version(), NOW);
    const rejected = rejectEdit(
      landEdits(approved, [proposal({})], brief, ['e1'], 'plainer'),
      'e1',
      NOW,
    );
    expect(rejected.segments).toEqual(approved.segments);
    expect(approvalStatus(rejected)).toBe('approved');
    expect(pendingEdits(rejected)).toEqual([]);
  });

  it('marks a suggestion unapplicable when its words were typed over', () => {
    const landed = landEdits(
      version(),
      [proposal({})],
      brief,
      ['e1'],
      'plainer',
    );
    const typedOver: Version = {
      ...landed,
      segments: landed.segments.map((s) =>
        s.id === 's1' ? { ...s, text: 'Completely different words.' } : s,
      ),
    };
    const result = acceptEdit(typedOver, 'e1', NOW);
    expect(result.edits?.[0].status).toBe('unapplicable');
    expect(result.segments[0].text).toBe('Completely different words.');
  });

  it('accepts all without one edit shifting another', () => {
    const landed = landEdits(
      version(),
      [
        proposal({}),
        proposal({ before: 'said a nurse', after: 'a nurse told us' }),
      ],
      brief,
      ['e1', 'e2'],
      'plainer',
    );
    const all = acceptAllEdits(landed, NOW);
    expect(all.segments[0].text).toBe(
      'Our teams use mobile clinics. “We had no clean water for eleven days” a nurse told us.',
    );
    expect(pendingEdits(all)).toEqual([]);
  });

  it('a new instruction replaces undecided suggestions but keeps decided ones', () => {
    const first = acceptEdit(
      landEdits(
        version(),
        [
          proposal({}),
          proposal({ before: 'said a nurse', after: 'said one nurse' }),
        ],
        brief,
        ['e1', 'e2'],
        'plainer',
      ),
      'e1',
      NOW,
    );
    const second = landEdits(
      first,
      [proposal({ before: 'mobile clinics', after: 'clinics on wheels' })],
      brief,
      ['e3'],
      'warmer',
    );
    expect(second.edits?.map((e) => [e.id, e.status])).toEqual([
      ['e1', 'accepted'],
      ['e3', 'pending'],
    ]);
  });

  it('discards every pending suggestion at once', () => {
    const landed = landEdits(
      version(),
      [proposal({})],
      brief,
      ['e1'],
      'plainer',
    );
    expect(pendingEdits(discardPendingEdits(landed, NOW))).toEqual([]);
  });
});
