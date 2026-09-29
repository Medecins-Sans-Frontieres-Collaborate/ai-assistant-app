/**
 * The derived citation model: what the UI renders for each sentence from
 * the stored verdicts, when a verdict lapses, and which sentences the next
 * cite call should send.
 */
import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  citationMarks,
  citedItemIds,
  isVerdictStale,
  pendingClaims,
  sentencesOf,
  specsUsingItem,
} from '@/lib/utils/shared/drafter/core/citations';
import { BRIEF_ITSELF } from '@/lib/utils/shared/drafter/core/grounding';
import { statementKey } from '@/lib/utils/shared/drafter/core/statements';
import {
  editSegmentText,
  emptyVersion,
  landVerdicts,
  verdictDigestFor,
} from '@/lib/utils/shared/drafter/core/versions';

import {
  Brief,
  BriefItem,
  Segment,
  StatementVerdict,
  Version,
} from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';
const LATER = '2026-09-21T11:00:00.000Z';

function item(partial: Partial<BriefItem> & { id: string }): BriefItem {
  return {
    kind: 'fact',
    text: '',
    provenance: [],
    verified: 'verbatim',
    decision: 'included',
    ...partial,
  };
}

function briefWith(items: BriefItem[], patch: Partial<Brief> = {}): Brief {
  return {
    ...emptyBrief(),
    language: 'English',
    keyMessage: 'Clean water must reach every camp now',
    items,
    ...patch,
  };
}

function seg(id: string, text: string): Segment {
  return { id, text, usedItemIds: [] };
}

const BRIEF = briefWith([
  item({
    id: 'q1',
    kind: 'quote',
    text: 'We had no clean water for eleven days',
    attribution: { name: 'Amina Yusuf', role: 'nurse' },
  }),
  item({
    id: 'f2',
    kind: 'figure',
    text: 'The clinic treated 1,200 patients in March',
  }),
  item({ id: 'f3', text: 'Cholera cases doubled since January' }),
]);

const S1 = 'Cholera cases have doubled since January.';
const S2 = '“We had no clean water for eleven days” said Amina Yusuf.';
const S3 = 'The clinic treated 9,999 patients in March.';
const S4 = 'We are proud of our teams.';

function versionWith(
  verdicts: Array<Omit<StatementVerdict, 'id' | 'at'>>,
  at = NOW,
): Version {
  const base: Version = {
    ...emptyVersion('x'),
    segments: [seg('s1', `${S1} ${S2}`), seg('s2', `${S3} ${S4}`)],
  };
  return landVerdicts(
    base,
    verdicts,
    verdicts.map((_, i) => `v${i}`),
    at,
  );
}

function verdict(
  segmentId: string,
  text: string,
  result: StatementVerdict['verdict'],
  itemIds: string[],
  brief: Brief = BRIEF,
): Omit<StatementVerdict, 'id' | 'at'> {
  return {
    segmentId,
    sentenceKey: statementKey(text),
    verdict: result,
    itemIds,
    reason: 'Because.',
    briefDigest: verdictDigestFor(brief, itemIds, result),
    modelId: 'gpt',
  };
}

describe('sentencesOf', () => {
  it('cuts sentences around quotations and keys them', () => {
    const sentences = sentencesOf(seg('s1', `${S1} ${S2}`), BRIEF);
    expect(sentences.map((s) => s.text)).toEqual([S1, S2]);
    expect(sentences[1].key).toBe(statementKey(S2));
    expect(sentences[0]).toMatchObject({
      segmentId: 's1',
      start: 0,
      end: S1.length,
    });
  });
});

describe('citationMarks', () => {
  it('is pending without a verdict, and carries the verdict when one applies', () => {
    const version = versionWith([
      verdict('s1', S1, 'supported', ['f3']),
      verdict('s2', S4, 'unsupported', []),
    ]);
    const marks = citationMarks(version.segments, version, BRIEF);
    expect(marks.map((m) => [m.segmentId, m.verdict, m.itemIds])).toEqual([
      ['s1', 'supported', ['f3']],
      ['s1', 'pending', []],
      ['s2', 'unsupported', []],
      ['s2', 'unsupported', []],
    ]);
    expect(marks[0]).toMatchObject({
      key: statementKey(S1),
      reason: 'Because.',
      modelId: 'gpt',
      at: NOW,
      start: 0,
      end: S1.length,
    });
    expect(marks[1]).not.toHaveProperty('reason');
  });

  it("forces a sentence with an ungrounded number or quote to 'unsupported', whatever the model said", () => {
    const version = versionWith([verdict('s2', S3, 'supported', ['f2'])]);
    const marks = citationMarks(version.segments, version, BRIEF);
    expect(marks[2]).toMatchObject({
      verdict: 'unsupported',
      itemIds: [],
      note: 'ungrounded-inside',
    });
    // Not sent again either: its verdict is code's, until it is reworded.
    expect(pendingClaims(version.segments, version, BRIEF)).toEqual([
      { segmentId: 's1', text: S1 },
      { segmentId: 's1', text: S2 },
      { segmentId: 's2', text: S4 },
    ]);
  });

  it('lapses when a cited item is excluded, edited or deleted, or the key message changes', () => {
    const version = versionWith([verdict('s1', S1, 'supported', ['f3'])]);
    const applies = (brief: Brief) =>
      citationMarks(version.segments, version, brief)[0].verdict;
    expect(applies(BRIEF)).toBe('supported');
    const excluded = {
      ...BRIEF,
      items: BRIEF.items.map((i) =>
        i.id === 'f3' ? { ...i, decision: 'excluded' as const } : i,
      ),
    };
    expect(applies(excluded)).toBe('stale');
    const edited = {
      ...BRIEF,
      items: BRIEF.items.map((i) =>
        i.id === 'f3'
          ? { ...i, text: 'Cholera cases halved since January' }
          : i,
      ),
    };
    expect(applies(edited)).toBe('stale');
    const deleted = {
      ...BRIEF,
      items: BRIEF.items.filter((i) => i.id !== 'f3'),
    };
    expect(applies(deleted)).toBe('stale');
    expect(applies({ ...BRIEF, keyMessage: 'Something else' })).toBe('stale');
    // An unrelated item's edit leaves a verdict on f3 alone.
    const other = {
      ...BRIEF,
      items: BRIEF.items.map((i) =>
        i.id === 'f2' ? { ...i, text: 'The clinic treated 1,300 patients' } : i,
      ),
    };
    expect(applies(other)).toBe('supported');
    // Links are placed by code and say nothing about what a sentence states.
    expect(
      applies({
        ...BRIEF,
        links: [{ role: 'article', label: 'A', url: 'https://a.org' }],
      }),
    ).toBe('supported');
  });

  it('lapses an unsupported verdict on any change to the included items, since a new one could support it', () => {
    const version = versionWith([verdict('s2', S4, 'unsupported', [])]);
    const applies = (brief: Brief) =>
      citationMarks(version.segments, version, brief)[3].verdict;
    expect(applies(BRIEF)).toBe('unsupported');
    expect(
      applies({
        ...BRIEF,
        items: [
          ...BRIEF.items,
          item({ id: 'f9', text: 'Our teams are proud' }),
        ],
      }),
    ).toBe('stale');
    expect(
      applies({ ...BRIEF, items: BRIEF.items.filter((i) => i.id !== 'q1') }),
    ).toBe('stale');
  });

  it('treats a verdict without a digest as stale, and a reworded sentence as pending', () => {
    const digestless = versionWith([
      { ...verdict('s1', S1, 'supported', ['f3']), briefDigest: undefined },
    ]);
    expect(
      citationMarks(digestless.segments, digestless, BRIEF)[0].verdict,
    ).toBe('stale');
    expect(isVerdictStale(digestless.verdicts![0], BRIEF)).toBe(true);
    const version = versionWith([verdict('s1', S1, 'supported', ['f3'])]);
    const reworded = editSegmentText(
      version,
      's1',
      `Cholera cases have tripled since January. ${S2}`,
    );
    expect(citationMarks(reworded.segments, reworded, BRIEF)[0].verdict).toBe(
      'pending',
    );
    // Typography-only changes keep it.
    const retyped = editSegmentText(
      version,
      's1',
      `Cholera cases  have doubled since January! ${S2}`,
    );
    expect(citationMarks(retyped.segments, retyped, BRIEF)[0].verdict).toBe(
      'supported',
    );
  });

  it('follows a sentence into another segment after a split', () => {
    const version = versionWith([
      verdict('s2', S4, 'supported', [BRIEF_ITSELF]),
    ]);
    const moved: Version = {
      ...version,
      segments: [seg('s2', S3), seg('s9', S4)],
    };
    const marks = citationMarks(moved.segments, moved, BRIEF);
    expect(marks.map((m) => [m.segmentId, m.verdict])).toEqual([
      ['s2', 'unsupported'],
      ['s9', 'supported'],
    ]);
  });

  it('keeps the newest verdict per sentence and memoises per segment, brief and verdicts', () => {
    const version = versionWith([verdict('s1', S1, 'partly', ['f3'])]);
    const newer = landVerdicts(
      version,
      [verdict('s1', S1, 'supported', ['f3'])],
      ['v9'],
      LATER,
    );
    expect(citationMarks(newer.segments, newer, BRIEF)[0]).toMatchObject({
      verdict: 'supported',
      at: LATER,
    });
    const first = citationMarks(newer.segments, newer, BRIEF);
    expect(citationMarks(newer.segments, newer, BRIEF)).toEqual(first);
    expect(citationMarks([newer.segments[0]], newer, BRIEF)[0]).toBe(first[0]);
    // A new verdicts array recomputes; the same one does not.
    expect(citationMarks(newer.segments, version, BRIEF)[0]).not.toBe(first[0]);
  });
});

describe('what the cite step needs', () => {
  it('lists pending and stale sentences once each, in order', () => {
    const version = versionWith([
      verdict('s1', S1, 'supported', ['f3']),
      { ...verdict('s2', S4, 'unclear', []), briefDigest: 'old' },
    ]);
    expect(pendingClaims(version.segments, version, BRIEF)).toEqual([
      { segmentId: 's1', text: S2 },
      { segmentId: 's2', text: S4 },
    ]);
    expect(pendingClaims([], version, BRIEF)).toEqual([]);
  });

  it('derives used items from supported and partly citations, never the brief itself', () => {
    const version = versionWith([
      verdict('s1', S1, 'partly', ['f3', BRIEF_ITSELF]),
      verdict('s2', S4, 'unsupported', []),
      verdict('s2', S3, 'supported', ['f2']),
    ]);
    const marks = citationMarks(version.segments, version, BRIEF);
    // f2 was cited over an ungrounded number: forced unsupported, not used.
    expect(citedItemIds(marks)).toEqual(['f3']);
    const versions = { x: version, y: { segments: [seg('t1', S4)] } };
    expect(specsUsingItem('f3', versions, BRIEF)).toEqual(['x']);
    expect(specsUsingItem('q1', versions, BRIEF)).toEqual(['x']);
    expect(specsUsingItem('f2', versions, BRIEF)).toEqual([]);
  });
});
