import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  canPublish,
  publishBlockers,
} from '@/lib/utils/shared/drafter/core/publishing';
import { landEdits } from '@/lib/utils/shared/drafter/core/revisions';
import {
  approveVersion,
  briefDigestFor,
  editSegmentText,
  emptyVersion,
} from '@/lib/utils/shared/drafter/core/versions';
import { CheckFinding } from '@/lib/utils/shared/review/deterministicChecks';

import { Brief, BriefItem, Version } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';
const QUOTE = 'We had no clean water for eleven days';

function item(partial: Partial<BriefItem> = {}): BriefItem {
  return {
    id: 'q1',
    kind: 'quote',
    text: QUOTE,
    provenance: [],
    verified: 'verbatim',
    decision: 'included',
    ...partial,
  };
}

function briefWith(items: BriefItem[]): Brief {
  return { ...emptyBrief(), keyMessage: 'Water is life', items };
}

/** A written, current, approved version resting on `q1`. */
function ready(brief: Brief): Version {
  const draft: Version = {
    ...emptyVersion('x'),
    segments: [
      { id: 's1', text: `“${QUOTE}” said a nurse.`, usedItemIds: ['q1'] },
    ],
    briefDigest: briefDigestFor(brief, ['q1']),
  };
  return approveVersion(draft, NOW);
}

const blocking: CheckFinding = {
  checkId: 'length',
  severity: 'block',
  messageKey: 'overLimit',
};
const warning: CheckFinding = {
  checkId: 'hashtags',
  severity: 'warn',
  messageKey: 'tooManyHashtags',
};

describe('publishBlockers', () => {
  it('lets a checked, current, approved version through', () => {
    const brief = briefWith([item()]);
    expect(publishBlockers(ready(brief), brief, [warning])).toEqual([]);
    expect(canPublish(ready(brief), brief, [])).toBe(true);
  });

  it('refuses nothing-written outright', () => {
    const brief = briefWith([item()]);
    expect(publishBlockers(undefined, brief, [])).toEqual(['empty']);
    expect(publishBlockers(emptyVersion('x'), brief, [])).toEqual(['empty']);
  });

  it('a blocking finding blocks; a warning does not', () => {
    const brief = briefWith([item()]);
    expect(publishBlockers(ready(brief), brief, [blocking])).toEqual([
      'to-fix',
    ]);
  });

  it('needs an approval, and one that still holds', () => {
    const brief = briefWith([item()]);
    const unapproved = { ...ready(brief), approval: undefined };
    expect(publishBlockers(unapproved, brief, [])).toEqual(['not-approved']);
    const edited = editSegmentText(
      ready(brief),
      's1',
      `“${QUOTE}” said one nurse.`,
    );
    expect(publishBlockers(edited, brief, [])).toEqual(['approval-lapsed']);
  });

  it('waits for pending suggestions and for a pending rewrite', () => {
    const brief = briefWith([item()]);
    const withSuggestion = landEdits(
      ready(brief),
      [
        {
          segmentId: 's1',
          before: 'said a nurse',
          after: 'a nurse said',
          reason: '',
        },
      ],
      brief,
      ['e1'],
      'reorder',
    );
    expect(publishBlockers(withSuggestion, brief, [])).toEqual([
      'suggestions-pending',
    ]);
    const withProposal: Version = {
      ...ready(brief),
      proposed: { segments: [], briefRev: 1, reason: 'brief' },
    };
    expect(publishBlockers(withProposal, brief, [])).toEqual([
      'proposal-pending',
    ]);
  });

  it('refuses a version written from a brief that has since changed', () => {
    const brief = briefWith([item()]);
    const version = ready(brief);
    const changed = { ...brief, keyMessage: 'Something else entirely' };
    expect(publishBlockers(version, changed, [])).toContain('brief-changed');
  });

  it('refuses a post resting on an item the user later excluded', () => {
    const included = briefWith([item()]);
    const version = ready(included);
    const excluded = briefWith([item({ decision: 'excluded' })]);
    expect(publishBlockers(version, excluded, [])).toContain(
      'uses-excluded-item',
    );
  });

  it('refuses a vouched item unless the organisation allows it', () => {
    const brief = briefWith([item({ verified: 'user-asserted' })]);
    expect(publishBlockers(ready(brief), brief, [])).toEqual([
      'uses-vouched-item',
    ]);
    expect(
      publishBlockers(ready(brief), brief, [], { allowVouched: true }),
    ).toEqual([]);
  });

  it('asks for approval last, after everything that would change the text', () => {
    const brief = briefWith([item()]);
    const unapproved = { ...ready(brief), approval: undefined };
    const blockers = publishBlockers(unapproved, brief, [blocking]);
    expect(blockers[0]).toBe('to-fix');
    expect(blockers[blockers.length - 1]).toBe('not-approved');
  });
});
