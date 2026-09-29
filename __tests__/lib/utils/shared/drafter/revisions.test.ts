import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import { groundSegment } from '@/lib/utils/shared/drafter/core/grounding';
import {
  acceptAllEdits,
  acceptEdit,
  admissibleEdits,
  discardPendingEdits,
  landEdits,
  pendingEdits,
  protectedRanges,
  rejectEdit,
} from '@/lib/utils/shared/drafter/core/revisions';
import {
  approvalStatus,
  approveVersion,
  emptyVersion,
} from '@/lib/utils/shared/drafter/core/versions';

import { Brief, ProposedEdit, Version, VersionEdit } from '@/types/drafter';

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

const FULL = '“We had no clean water for eleven days”';

describe('shortening a quotation in suggestions', () => {
  const segments = version().segments;

  it('admits a suggestion that cuts a quotation down to a part that still grounds on the same item', () => {
    const kept = admissibleEdits(
      [
        proposal({ before: FULL, after: '“no clean water for eleven days”' }),
        proposal({
          segmentId: 's1',
          before: 'had no clean water for eleven days”',
          after: 'had no clean water”',
        }),
      ],
      segments,
      brief,
    );
    // The second overlaps the first, so only the first is kept; alone, a
    // cut from the tail is admitted too.
    expect(kept.map((e) => e.after)).toEqual([
      '“no clean water for eleven days”',
    ]);
    expect(
      admissibleEdits(
        [
          proposal({
            before: 'had no clean water for eleven days”',
            after: 'had no clean water”',
          }),
        ],
        segments,
        brief,
      ),
    ).toHaveLength(1);
  });

  it('accepts such an edit and the shortened quotation stays protected, whole', () => {
    const landed = landEdits(
      version(),
      [proposal({ before: FULL, after: '“no clean water for eleven days”' })],
      brief,
      ['e1'],
      'shorter',
    );
    expect(pendingEdits(landed)).toHaveLength(1);
    const accepted = acceptEdit(landed, 'e1', NOW, brief);
    expect(accepted.edits?.[0].status).toBe('accepted');
    const text = accepted.segments[0].text;
    expect(text).toBe(
      'Our teams utilise mobile clinics. “no clean water for eleven days” said a nurse.',
    );
    const ranges = protectedRanges(accepted.segments[0], brief);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual([
      '“no clean water for eleven days”',
    ]);
  });

  it('refuses a cut that starts the quotation right after a negation', () => {
    const kept = admissibleEdits(
      [proposal({ before: FULL, after: '“clean water for eleven days”' })],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
  });

  it('refuses a cut that ends the quotation right after its negation [EQ-3]', () => {
    const negated: Brief = {
      ...brief,
      items: [
        {
          ...brief.items[0],
          text: 'We could not have asked for better care from the team',
        },
      ],
    };
    const text =
      'Intro. “We could not have asked for better care from the team” said Ali.';
    const kept = admissibleEdits(
      [
        proposal({
          before: 'have asked for better care from the team”',
          after: '…”',
        }),
        proposal({ before: 'not have … team”', after: 'not”' }),
        proposal({
          before: '“We could not have asked for better care from the team”',
          after: '“We could not …”',
        }),
      ],
      [{ id: 's1', text, usedItemIds: ['q1'] }],
      negated,
    );
    expect(kept).toEqual([]);
  });

  it('refuses an elision that leaves a fragment of one word', () => {
    const kept = admissibleEdits(
      [proposal({ before: FULL, after: '“We had no clean water … days”' })],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
  });

  it('still refuses a rewording inside a quotation', () => {
    const kept = admissibleEdits(
      [
        proposal({ before: 'no clean water', after: 'no safe water' }),
        proposal({
          before: FULL,
          after: '“We had no safe water … eleven days”',
        }),
        proposal({
          before: FULL,
          after: '“We had no clean water for eleven days, honestly”',
        }),
      ],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
  });

  it('refuses an edit that rewrites the attribution tail together with the quote', () => {
    const kept = admissibleEdits(
      [
        proposal({
          before: `${FULL} said a nurse.`,
          after: '“We had no clean water … eleven days” a nurse told us.',
        }),
        proposal({
          before: `clinics. ${FULL}`,
          after: 'clinics: “We had no clean water … eleven days”',
        }),
      ],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
  });

  it('still refuses an edit on a link', () => {
    const kept = admissibleEdits(
      [proposal({ segmentId: 's2', before: LINK, after: `${LINK}?utm=x` })],
      segments,
      brief,
    );
    expect(kept).toEqual([]);
  });

  it('turns an elision edit unapplicable when the text changed so it no longer grounds', () => {
    const changedBrief: Brief = {
      ...brief,
      items: [
        {
          ...brief.items[0],
          text: 'We had no clean water and not for eleven days',
        },
      ],
    };
    const edit: VersionEdit = {
      id: 'e1',
      segmentId: 's1',
      criterion: 'revision',
      before: 'for eleven days”',
      after: '… eleven days”',
      reason: 'Shorter',
      severity: 'minor',
      status: 'pending',
    };
    const text =
      'Our teams use mobile clinics. “We had no clean water and not for eleven days” said a nurse.';
    const current: Version = {
      ...version(),
      segments: [{ id: 's1', text, usedItemIds: ['q1'] }],
      edits: [edit],
    };
    // The quotation is grounded, so the edit is only admissible as an
    // elision, and "and not … eleven days" ends its first run in a negator.
    expect(protectedRanges(current.segments[0], changedBrief)).toHaveLength(1);
    const result = acceptEdit(current, 'e1', NOW, changedBrief);
    expect(result.edits?.[0].status).toBe('unapplicable');
    expect(result.segments[0].text).toBe(text);
  });
});

/**
 * These need `groundSegment` to match elided quotations (grounding.ts,
 * WI-2). Until it does they are SKIPPED, never passed: the probe is the very
 * capability they rest on, so a skip here means grounding.ts has not landed.
 */
const groundsElidedQuotes = groundSegment(
  {
    id: 'probe',
    text: '“We had no clean water … eleven days”',
    usedItemIds: [],
  },
  brief,
).some((mark) => mark.kind === 'quote' && mark.itemId === 'q1');

describe.skipIf(!groundsElidedQuotes)(
  'elided quotations in suggestions',
  () => {
    const segments = version().segments;

    it('admits a suggestion that shortens a quotation by an elision of the same item', () => {
      const kept = admissibleEdits(
        [
          proposal({
            before: FULL,
            after: '“We had no clean water … eleven days”',
          }),
        ],
        segments,
        brief,
      );
      expect(kept.map((e) => e.after)).toEqual([
        '“We had no clean water … eleven days”',
      ]);
      // Without the marks in `before`, the edited region is still inside them.
      const inner = admissibleEdits(
        [
          proposal({
            before: 'clean water for eleven days',
            after: 'clean water … eleven days',
          }),
        ],
        segments,
        brief,
      );
      expect(inner).toHaveLength(1);
    });

    it('accepts an admitted elision and the quotation stays protected, whole', () => {
      const landed = landEdits(
        version(),
        [
          proposal({
            before: FULL,
            after: '“We had no clean water … eleven days”',
          }),
        ],
        brief,
        ['e1'],
        'shorter',
      );
      expect(pendingEdits(landed)).toHaveLength(1);
      const accepted = acceptEdit(landed, 'e1', NOW, brief);
      expect(accepted.edits?.[0].status).toBe('accepted');
      const text = accepted.segments[0].text;
      expect(text).toBe(
        'Our teams utilise mobile clinics. “We had no clean water … eleven days” said a nurse.',
      );
      const ranges = protectedRanges(accepted.segments[0], brief);
      expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual([
        '“We had no clean water … eleven days”',
      ]);
    });

    it('protects an elided quotation with a bracketed insertion whole', () => {
      const text =
        'Our teams utilise mobile clinics. “[The team] had no clean water … eleven days” said a nurse.';
      const teamBrief: Brief = {
        ...brief,
        items: [
          {
            ...brief.items[0],
            text: 'The team had no clean water for eleven days',
          },
        ],
      };
      const ranges = protectedRanges(
        { id: 's1', text, usedItemIds: ['q1'] },
        teamBrief,
      );
      expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual([
        '“[The team] had no clean water … eleven days”',
      ]);
      // An insertion may only hold words the item, its attribution or the
      // stop list already has (§5): a new word breaks the grounding and the
      // edit is refused; a rewording within those words still grounds on the
      // same item with the edited region inside the mark, so §9 admits it.
      const refused = admissibleEdits(
        [proposal({ before: '[The team]', after: '[The army]' })],
        [{ id: 's1', text, usedItemIds: ['q1'] }],
        teamBrief,
      );
      expect(refused).toEqual([]);
      const admitted = admissibleEdits(
        [proposal({ before: '[The team]', after: '[Our team]' })],
        [{ id: 's1', text, usedItemIds: ['q1'] }],
        teamBrief,
      );
      expect(admitted.map((e) => e.after)).toEqual(['[Our team]']);
    });
  },
);
