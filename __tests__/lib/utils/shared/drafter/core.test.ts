import { normalizeForQuoteMatch } from '@/lib/utils/app/citationQuotes';
import {
  checkVersion,
  getSpecAdapter,
} from '@/lib/utils/shared/drafter/adapters';
import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  addExtractedItems,
  addItemFromSelection,
  editItemText,
  emptyBrief,
  includeAllVerified,
  resolveItemFromSelection,
  setItemDecision,
  vouchForItem,
} from '@/lib/utils/shared/drafter/core/brief';
import {
  X_URL_WEIGHT,
  countText,
  overflowIndex,
} from '@/lib/utils/shared/drafter/core/counting';
import {
  canonicalNumber,
  findNames,
  findNumbers,
  findQuotedSpans,
  groundVersion,
  numbersSupported,
  summarizeProof,
  ungroundedNames,
} from '@/lib/utils/shared/drafter/core/grounding';
import {
  mergeWithPrevious,
  moveOverflow,
  segmentOverflow,
  splitSegment,
} from '@/lib/utils/shared/drafter/core/segments';
import {
  buildTextFragmentUrl,
  sourceLinkFor,
} from '@/lib/utils/shared/drafter/core/textFragment';
import {
  locateExcerpt,
  normalizeWithMap,
  passageAround,
} from '@/lib/utils/shared/drafter/core/verify';
import {
  applyGenerated,
  approvalStatus,
  approveVersion,
  changedSinceCopied,
  editSegmentText,
  isReadyToApprove,
  isStale,
  keepMine,
  markCopied,
  useProposed,
  versionStatuses,
} from '@/lib/utils/shared/drafter/core/versions';

import { Brief, BriefItem, DraftSource, Segment } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';

function item(partial: Partial<BriefItem> & { id: string }): BriefItem {
  return {
    kind: 'quote',
    text: 'We had no clean water for eleven days',
    provenance: [],
    verified: 'verbatim',
    decision: 'included',
    ...partial,
  };
}

function briefWith(items: BriefItem[], patch: Partial<Brief> = {}): Brief {
  return { ...emptyBrief(), language: 'English', items, ...patch };
}

function seg(id: string, text: string, usedItemIds: string[] = []): Segment {
  return { id, text, usedItemIds };
}

describe('counting', () => {
  it('counts graphemes, not UTF-16 units', () => {
    expect(countText('graphemes', '👩‍👩‍👧 ok')).toBe(4);
    expect(countText('graphemes', 'مرحبا')).toBe(5);
  });

  it('weights links and wide scripts the way X does', () => {
    const link = 'https://example.org/a/very/long/path/that/goes/on';
    expect(countText('x-weighted', link)).toBe(X_URL_WEIGHT);
    expect(countText('x-weighted', `Read ${link}.`)).toBe(5 + X_URL_WEIGHT + 1);
    expect(countText('x-weighted', '日本')).toBe(4);
    expect(countText('x-weighted', '👍')).toBe(2);
  });

  it('reports where text stops fitting, on a unit boundary', () => {
    expect(overflowIndex('graphemes', 'abcdef', 6)).toBeNull();
    expect(overflowIndex('graphemes', 'abcdef', 4)).toBe(4);
    // Never inside a link: the link as a whole is what does not fit.
    expect(overflowIndex('x-weighted', 'ab https://example.org/x', 10)).toBe(3);
  });
});

describe('verify', () => {
  const source =
    'The nurse said:  “We had no clean water — for eleven days.”\nThen the trucks came.';

  it('normalizes exactly like normalizeForQuoteMatch', () => {
    for (const sample of [source, '  A­B  “x” – y ', 'İstanbul  ok']) {
      expect(normalizeWithMap(sample).text).toBe(
        normalizeForQuoteMatch(sample),
      );
    }
  });

  it('locates an excerpt in the original text despite typography', () => {
    const range = locateExcerpt(
      source,
      '"we had no clean water - for eleven days."',
    );
    expect(range).not.toBeNull();
    expect(source.slice(range!.start, range!.end)).toBe(
      '“We had no clean water — for eleven days.”',
    );
    const passage = passageAround(source, range!, 10);
    expect(passage.before.endsWith(':  ')).toBe(true);
    expect(passage.clippedStart).toBe(true);
  });

  it('rejects text that is not there, and excerpts too short to prove', () => {
    expect(
      locateExcerpt(source, 'We had no clean water for twelve days'),
    ).toBeNull();
    expect(locateExcerpt(source, 'the')).toBeNull();
  });
});

describe('grounding', () => {
  it('finds quotations but not short quoted labels', () => {
    const spans = findQuotedSpans(
      'He called it "a disaster" and “we had no water”.',
    );
    expect(spans.map((s) => s.inner)).toEqual(['we had no water']);
  });

  it('canonicalizes numbers so separators agree and decimals do not collide', () => {
    expect(canonicalNumber('1,200')).toBe('1200');
    expect(canonicalNumber('1 200')).toBe('1200');
    expect(canonicalNumber('1.200')).toBe('1200');
    expect(canonicalNumber('1.5')).toBe('1.5');
    expect(canonicalNumber('1,5')).toBe('1.5');
    expect(canonicalNumber('15')).toBe('15');
    expect(canonicalNumber('40 %')).toBe('40%');
  });

  it('skips links, handles, hashtags and bare single digits', () => {
    const found = findNumbers(
      '3 things: 1,200 people, #COP28 @msf2 https://a.org/2026',
    );
    expect(found.map((n) => n.canonical)).toEqual(['1200']);
  });

  it('marks a fabricated quote and an unknown number as ungrounded', () => {
    const brief = briefWith([
      item({ id: 'q1' }),
      item({
        id: 'f1',
        kind: 'figure',
        text: 'The clinic treated 1,200 patients',
      }),
    ]);
    const marks = groundVersion(
      [
        seg(
          's1',
          '“We had no clean water for eleven days” said a nurse. 1 200 treated.',
        ),
        seg(
          's2',
          '“Nobody came to help us at all” and 5,000 more are waiting.',
        ),
      ],
      brief,
    );
    expect(marks.map((m) => [m.segmentId, m.kind, m.itemId])).toEqual([
      ['s1', 'quote', 'q1'],
      ['s1', 'number', 'f1'],
      ['s2', 'quote', undefined],
      ['s2', 'number', undefined],
    ]);
    expect(summarizeProof(marks, brief)).toEqual({
      total: 4,
      traced: 2,
      vouched: 0,
      ungrounded: 2,
    });
  });

  it('does not ground against an item the user has not included', () => {
    const brief = briefWith([item({ id: 'q1', decision: undefined })]);
    const [mark] = groundVersion(
      [seg('s1', '“We had no clean water for eleven days”')],
      brief,
    );
    expect(mark.itemId).toBeUndefined();
  });
});

describe('names', () => {
  it('finds multi-word names and drops a sentence-initial word', () => {
    const found = findNames(
      'The Clinic reopened. Yesterday Amina Yusuf spoke in South Sudan. Aid arrived.',
    );
    expect(found.map((n) => n.name)).toEqual(['Amina Yusuf', 'South Sudan']);
  });

  it('warns only about names the brief never mentions', () => {
    const brief = briefWith([
      item({
        id: 'q1',
        attribution: { name: 'Amina Yusuf', role: 'nurse' },
      }),
    ]);
    const hits = ungroundedNames(
      [seg('s1', 'We heard from Amina Yusuf and from Jean Martin today.')],
      brief,
    );
    expect(hits.map((h) => h.name)).toEqual(['Jean Martin']);
  });

  it('is a warning, never a block', () => {
    const adapter = getSpecAdapter('channel')!;
    const findings = checkVersion(
      adapter,
      getChannelProfile('linkedin')!,
      [seg('s1', 'We heard from Jean Martin today.')],
      briefWith([item({ id: 'q1' })]),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: 'name-grounded',
        severity: 'warn',
        values: { name: 'Jean Martin' },
      }),
    ]);
  });
});

describe('segments', () => {
  const segments = [
    seg('a', 'First sentence. Second sentence.'),
    seg('b', 'Third.'),
  ];

  it('splits at the caret and merges back', () => {
    const split = splitSegment(segments, 'a', 16, 'n');
    expect(split.map((s) => s.text)).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third.',
    ]);
    expect(mergeWithPrevious(split, 'n').map((s) => s.text)).toEqual(
      segments.map((s) => s.text),
    );
  });

  it('returns the same array when there is nothing to do', () => {
    expect(splitSegment(segments, 'a', 0, 'n')).toBe(segments);
    expect(mergeWithPrevious(segments, 'a')).toBe(segments);
  });

  it('moves an overflow to a new post at a sentence end, budgeting numbering', () => {
    const long = [
      seg('a', 'One two three four. Five six seven eight nine ten.'),
    ];
    const moved = moveOverflow(long, 'a', 'n', {
      rule: 'graphemes',
      limit: 30,
      numbered: true,
      maxSegments: 5,
    });
    expect(moved.map((s) => s.text)).toEqual([
      'One two three four.',
      'Five six seven eight nine ten.',
    ]);
    // "Five … ten." is 30 characters, but " 2/2" is counted too.
    expect(
      segmentOverflow(moved, 1, {
        rule: 'graphemes',
        limit: 30,
        numbered: true,
      }).over,
    ).toBe(4);
  });

  it('will not create a post the spec does not allow', () => {
    const one = [seg('a', 'One two three four. Five six seven.')];
    expect(
      moveOverflow(one, 'a', 'n', {
        rule: 'graphemes',
        limit: 20,
        numbered: false,
        maxSegments: 1,
      }),
    ).toBe(one);
  });
});

describe('brief', () => {
  it('adds extracted items undecided, quotes first, without repeats', () => {
    const brief = addExtractedItems(
      emptyBrief(),
      [
        {
          kind: 'figure',
          text: '1,200 treated',
          provenance: [],
          verified: 'verbatim',
        },
        {
          kind: 'quote',
          text: 'We had no water',
          provenance: [],
          verified: 'verbatim',
        },
        {
          kind: 'quote',
          text: 'we had  no water',
          provenance: [],
          verified: 'verbatim',
        },
      ],
      ['i1', 'i2', 'i3'],
    );
    expect(brief.items.map((i) => i.kind)).toEqual(['quote', 'figure']);
    expect(brief.items.every((i) => i.decision === undefined)).toBe(true);
    expect(brief.rev).toBe(1);
  });

  it('never includes a "Not found" item, in bulk or one by one', () => {
    const start = briefWith([
      item({ id: 'a', decision: undefined }),
      item({ id: 'b', decision: undefined, verified: 'unverified' }),
    ]);
    const bulk = includeAllVerified(start);
    expect(bulk.items.map((i) => i.decision)).toEqual(['included', undefined]);
    expect(setItemDecision(bulk, 'b', 'included')).toBe(bulk);
    const vouched = vouchForItem(bulk, 'b');
    expect(vouched.items[1].verified).toBe('user-asserted');
    expect(setItemDecision(vouched, 'b', 'included').items[1].decision).toBe(
      'included',
    );
  });

  it('clears an include when the item text is edited', () => {
    const brief = briefWith([item({ id: 'a' })]);
    const edited = editItemText(brief, 'a', 'Different words', 'unverified');
    expect(edited.items[0].decision).toBeUndefined();
    expect(edited.items[0].verified).toBe('unverified');
  });

  it('resolves a "Not found" quote to exactly the selected words', () => {
    const brief = briefWith([
      item({ id: 'a', verified: 'unverified', decision: undefined }),
    ]);
    const resolved = resolveItemFromSelection(
      brief,
      'a',
      'src1',
      ' We had no water at all ',
      false,
    );
    expect(resolved.items[0]).toMatchObject({
      text: 'We had no water at all',
      verified: 'verbatim',
      provenance: [{ sourceId: 'src1', excerpt: 'We had no water at all' }],
    });
  });

  it('accepts evidence for a statement only when its numbers are in it', () => {
    const brief = briefWith([
      item({
        id: 'f',
        kind: 'figure',
        text: 'The clinic treated 1,200 patients',
        verified: 'unverified',
        decision: undefined,
      }),
    ]);
    const weak = 'The clinic treated many patients in March';
    const strong = 'In March the clinic treated 1 200 patients';
    expect(numbersSupported(brief.items[0].text, weak)).toBe(false);
    expect(resolveItemFromSelection(brief, 'f', 'src1', weak, false)).toBe(
      brief,
    );
    const resolved = resolveItemFromSelection(
      brief,
      'f',
      'src1',
      strong,
      numbersSupported(brief.items[0].text, strong),
    );
    expect(resolved.items[0].verified).toBe('verbatim');
    expect(resolved.items[0].text).toBe('The clinic treated 1,200 patients');
  });

  it('adds a selection as verbatim and included', () => {
    const brief = addItemFromSelection(
      emptyBrief(),
      'i1',
      'src1',
      '  chosen words  ',
    );
    expect(brief.items[0]).toMatchObject({
      text: 'chosen words',
      verified: 'verbatim',
      decision: 'included',
      provenance: [{ sourceId: 'src1', excerpt: 'chosen words' }],
    });
  });
});

describe('versions', () => {
  const brief = briefWith([item({ id: 'q1' })], {
    keyMessage: 'Water is life',
  });
  const generated = {
    specId: 'x',
    segments: [
      { text: '“We had no clean water for eleven days”', usedItemIds: ['q1'] },
    ],
  };

  it('lands generated text directly into an empty column', () => {
    const version = applyGenerated(
      undefined,
      generated,
      brief,
      ['s1'],
      'first',
    );
    expect(version.segments).toHaveLength(1);
    expect(version.proposed).toBeUndefined();
    expect(isStale(version, brief)).toBe(false);
  });

  it('never replaces text the user has seen: a rewrite is proposed', () => {
    const first = applyGenerated(undefined, generated, brief, ['s1'], 'first');
    const second = applyGenerated(
      first,
      { specId: 'x', segments: [{ text: 'New words', usedItemIds: [] }] },
      brief,
      ['s2'],
      'update',
    );
    expect(second.segments).toBe(first.segments);
    expect(second.proposed?.segments[0].text).toBe('New words');
    expect(useProposed(second, brief, NOW).segments[0].text).toBe('New words');
    expect(keepMine(second, brief).proposed).toBeUndefined();
  });

  it('approval lapses on ANY text change and returns when the text does', () => {
    const version = approveVersion(
      applyGenerated(undefined, generated, brief, ['s1'], 'first'),
      NOW,
    );
    expect(approvalStatus(version)).toBe('approved');

    const typed = editSegmentText(version, 's1', 'Something else');
    expect(approvalStatus(typed)).toBe('changed');
    expect(typed.approval).toBeDefined();

    const regenerated = useProposed(
      applyGenerated(
        version,
        { specId: 'x', segments: [{ text: 'Rewritten', usedItemIds: [] }] },
        brief,
        ['s2'],
        'update',
      ),
      brief,
      NOW,
    );
    expect(approvalStatus(regenerated)).toBe('changed');

    const undone = editSegmentText(typed, 's1', version.segments[0].text);
    expect(approvalStatus(undone)).toBe('approved');
  });

  it('flags staleness only for brief changes the version depends on', () => {
    const version = applyGenerated(
      undefined,
      generated,
      brief,
      ['s1'],
      'first',
    );
    const unrelated = briefWith(
      [
        ...brief.items,
        item({ id: 'other', text: 'Another quote entirely here' }),
      ],
      { keyMessage: brief.keyMessage },
    );
    expect(isStale(version, unrelated)).toBe(false);
    const related = editItemText(brief, 'q1', 'We had no water', 'verbatim');
    expect(isStale(version, related)).toBe(true);
  });

  it('orders statuses worst first and gates "approve all ready"', () => {
    const version = applyGenerated(
      undefined,
      generated,
      brief,
      ['s1'],
      'first',
    );
    expect(versionStatuses(version, { brief, blocking: 0 })).toEqual(['ready']);
    expect(isReadyToApprove(version, { brief, blocking: 0 })).toBe(true);
    expect(versionStatuses(version, { brief, blocking: 2 })[0]).toBe('to-fix');
    expect(isReadyToApprove(version, { brief, blocking: 2 })).toBe(false);
    const approved = approveVersion(version, NOW);
    expect(versionStatuses(approved, { brief, blocking: 0 })).toEqual([
      'approved',
    ]);
    expect(versionStatuses(undefined, { brief, blocking: 0 })).toEqual([
      'empty',
    ]);
  });

  it('notices a change after copying', () => {
    const version = markCopied(
      applyGenerated(undefined, generated, brief, ['s1'], 'first'),
      NOW,
    );
    expect(changedSinceCopied(version)).toBe(false);
    expect(changedSinceCopied(editSegmentText(version, 's1', 'x'))).toBe(true);
  });
});

describe('source links', () => {
  it('builds a text fragment that escapes dashes and keeps an anchor', () => {
    expect(buildTextFragmentUrl('https://a.org/p#top', 'well-known fact')).toBe(
      'https://a.org/p#top:~:text=well%2Dknown%20fact',
    );
  });

  it('uses the start,end form for long excerpts', () => {
    const url = buildTextFragmentUrl(
      'https://a.org/p',
      'one two three four five six seven eight nine ten eleven twelve',
    );
    expect(url).toBe(
      'https://a.org/p#:~:text=one%20two%20three%20four%20five,eight%20nine%20ten%20eleven%20twelve',
    );
  });

  it('refuses non-web addresses and links M365 items without a fragment', () => {
    expect(buildTextFragmentUrl('javascript:alert(1)', 'x')).toBeNull();
    const base = { id: 's', name: 'n', chars: 1, addedAt: NOW };
    const m365: DraftSource = {
      ...base,
      kind: 'm365',
      url: 'https://contoso.sharepoint.com/doc.docx',
    };
    expect(sourceLinkFor(m365, 'words here')).toEqual({
      href: 'https://contoso.sharepoint.com/doc.docx',
      atPassage: false,
      host: 'contoso.sharepoint.com',
    });
    expect(sourceLinkFor({ ...base, kind: 'file' }, 'words')).toBeNull();
  });

  it('never links a source whose address is not a web address', () => {
    const base = { id: 's', name: 'n', chars: 1, addedAt: NOW };
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>']) {
      // `new URL` parses both without throwing; the M365 branch used to
      // hand the address back as the href.
      expect(sourceLinkFor({ ...base, kind: 'm365', url }, 'words')).toBeNull();
      expect(sourceLinkFor({ ...base, kind: 'url', url }, 'words')).toBeNull();
    }
    // The href is the parsed address: a line break the parser drops is gone.
    expect(
      sourceLinkFor(
        { ...base, kind: 'm365', url: 'https://contoso.sharepoint.com/a\nb' },
        'words',
      )?.href,
    ).toBe('https://contoso.sharepoint.com/ab');
  });
});

describe('channel adapter', () => {
  const adapter = getSpecAdapter('channel')!;
  const brief = briefWith([item({ id: 'q1' })]);

  it('resolves only known kinds and specs', () => {
    expect(getSpecAdapter('audience')).toBeUndefined();
    expect(getSpecAdapter(42)).toBeUndefined();
    expect(adapter.resolveSpec('nope')).toBeUndefined();
    expect(adapter.workflow).toBe('channel-drafter');
  });

  it('blocks an over-long post and warns on a long opening line', () => {
    const x = getChannelProfile('x')!;
    const findings = checkVersion(
      adapter,
      x,
      [seg('s1', 'a'.repeat(300))],
      brief,
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: 'length',
        severity: 'block',
        values: { count: 20, post: 1 },
        range: { start: 280, end: 300 },
      }),
    );

    const linkedin = getChannelProfile('linkedin')!;
    const slot = checkVersion(
      adapter,
      linkedin,
      [seg('s1', `${'b'.repeat(130)}\nrest of the post`)],
      brief,
    );
    expect(slot).toContainEqual(
      expect.objectContaining({ checkId: 'slot', severity: 'warn' }),
    );
  });

  it('counts thread numbering against the limit', () => {
    const x = getChannelProfile('x')!;
    const body = 'a'.repeat(278);
    expect(checkVersion(adapter, x, [seg('s1', body)], brief)).toEqual([]);
    const thread = checkVersion(
      adapter,
      x,
      [seg('s1', body), seg('s2', 'ok')],
      brief,
    );
    expect(thread.filter((f) => f.checkId === 'length')).toHaveLength(1);
  });

  it('carries the core grounding checks for every kind', () => {
    const x = getChannelProfile('x')!;
    const findings = checkVersion(
      adapter,
      x,
      [seg('s1', '“Nobody ever said these words” to 9,999 people')],
      brief,
    );
    expect(findings.map((f) => f.checkId).sort()).toEqual([
      'number-grounded',
      'quote-verbatim',
    ]);
  });
});
