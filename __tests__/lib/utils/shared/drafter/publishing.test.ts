import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  canPublish,
  publishBlockers,
} from '@/lib/utils/shared/drafter/core/publishing';
import { landEdits } from '@/lib/utils/shared/drafter/core/revisions';
import { statementKey } from '@/lib/utils/shared/drafter/core/statements';
import {
  approveVersion,
  briefDigestFor,
  editSegmentText,
  emptyVersion,
  landVerdicts,
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

  it('never lets a citation gate publishing: neither an unsupported sentence nor a cited vouched item', () => {
    const vouched = item({
      id: 'f1',
      kind: 'fact',
      text: 'The clinic reopened its maternity ward in March',
      verified: 'user-asserted',
    });
    const excluded = item({
      id: 'x1',
      kind: 'fact',
      text: 'The hospital closed permanently after the bombing',
      decision: 'excluded',
    });
    const brief = briefWith([item(), vouched, excluded]);
    const first = 'The clinic reopened the maternity ward in March.';
    const second = 'The hospital closed permanently after the bombing.';
    const version: Version = approveVersion(
      {
        ...emptyVersion('x'),
        segments: [{ id: 's1', text: `${first} ${second}`, usedItemIds: [] }],
        briefDigest: briefDigestFor(brief, []),
      },
      NOW,
    );
    // Nothing checkable by code rests on any item: publishable as is.
    expect(publishBlockers(version, brief, [])).toEqual([]);
    // The model's citations are an opinion: a sentence it attributes to the
    // vouched item, or calls unsupported, changes nothing at this gate.
    const cited = landVerdicts(
      version,
      [
        {
          segmentId: 's1',
          sentenceKey: statementKey(first),
          verdict: 'supported',
          itemIds: ['f1'],
          reason: 'Stated by the fact.',
        },
        {
          segmentId: 's1',
          sentenceKey: statementKey(second),
          verdict: 'unsupported',
          itemIds: [],
          reason: 'Not in the brief.',
        },
      ],
      ['v1', 'v2'],
      NOW,
    );
    expect(publishBlockers(cited, brief, [])).toEqual([]);
    // A quotation of the vouched item is code's finding, and does gate.
    const quoted: Version = approveVersion(
      {
        ...emptyVersion('x'),
        segments: [
          {
            id: 's1',
            text: 'A fact: 「The clinic reopened its maternity ward in March」.',
            usedItemIds: [],
          },
        ],
        briefDigest: briefDigestFor(brief, []),
      },
      NOW,
    );
    expect(publishBlockers(quoted, brief, [])).toEqual([]);
    const reported: Version = {
      ...quoted,
      segments: [{ ...quoted.segments[0], usedItemIds: ['f1'] }],
      briefDigest: briefDigestFor(brief, ['f1']),
    };
    expect(publishBlockers(approveVersion(reported, NOW), brief, [])).toEqual([
      'uses-vouched-item',
    ]);
  });

  it('asks for approval last, after everything that would change the text', () => {
    const brief = briefWith([item()]);
    const unapproved = { ...ready(brief), approval: undefined };
    const blockers = publishBlockers(unapproved, brief, [blocking]);
    expect(blockers[0]).toBe('to-fix');
    expect(blockers[blockers.length - 1]).toBe('not-approved');
  });
});
