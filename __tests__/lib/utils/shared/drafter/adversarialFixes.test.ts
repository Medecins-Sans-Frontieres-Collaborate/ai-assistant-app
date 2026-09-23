/**
 * One test per defect the adversarial review proved, so none comes back.
 */
import {
  checkVersion,
  getSpecAdapter,
} from '@/lib/utils/shared/drafter/adapters';
import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import { countText } from '@/lib/utils/shared/drafter/core/counting';
import {
  linkRanges,
  placeLinks,
  stripLinks,
} from '@/lib/utils/shared/drafter/core/links';
import { carryMedia } from '@/lib/utils/shared/drafter/core/media';
import {
  acceptEdit,
  admissibleEdits,
  blockingScore,
  landEdits,
  pendingEdits,
} from '@/lib/utils/shared/drafter/core/revisions';
import { pushOverflowForward } from '@/lib/utils/shared/drafter/core/segments';
import {
  applyGenerated,
  approveVersion,
  emptyVersion,
  isStale,
  restoreSnapshot,
  setSegments,
  useProposed,
} from '@/lib/utils/shared/drafter/core/versions';

import { Brief, MediaAttachment, Segment, Version } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';
const adapter = getSpecAdapter('channel')!;
const X = adapter.resolveSpec('x')!;
const SMS = adapter.resolveSpec('sms')!;

const seg = (
  id: string,
  text: string,
  usedItemIds: string[] = [],
): Segment => ({
  id,
  text,
  usedItemIds,
});

function briefWith(text: string): Brief {
  return {
    ...emptyBrief(),
    keyMessage: 'Water is life',
    items: [
      {
        id: 'i1',
        kind: 'fact',
        text,
        provenance: [],
        verified: 'verbatim',
        decision: 'included',
      },
    ],
  };
}

describe('counting rules', () => {
  it('stops a link at CJK text, which platforms do even with no space', () => {
    const text = `https://example.org/a，${'水'.repeat(100)}`;
    // 23 for the link, 2 for the full-width comma, 2 per character.
    expect(countText('x-weighted', text)).toBe(23 + 2 + 200);
    expect(countText('x-weighted', `请访问msf.org了解`)).toBe(6 + 23 + 4);
  });

  it('url-23 charges every link 23 and everything else one', () => {
    expect(countText('url-23', 'Read msf.org 🇸🇸')).toBe(5 + 23 + 1 + 1);
    expect(
      countText('url-23', `${'https://example.org/'}${'a'.repeat(80)}`),
    ).toBe(23);
  });

  it('utf16 never counts less than graphemes', () => {
    for (const text of ['plain', '👩‍👩‍👧 family', 'नमस्ते दुनिया', '🇸🇸']) {
      expect(countText('utf16', text)).toBeGreaterThanOrEqual(
        countText('graphemes', text),
      );
    }
    expect(countText('utf16', '👍')).toBe(2);
  });

  it('gsm7: one curly quote costs the message ninety characters', () => {
    expect(countText('gsm7', 'a'.repeat(160))).toBe(160);
    expect(countText('gsm7', 'Price: 5€ [now]')).toBe(15 + 3);
    // 70 code units of Unicode is exactly full; 71 is one over.
    expect(countText('gsm7', `“${'a'.repeat(69)}`)).toBe(160);
    expect(countText('gsm7', `“${'a'.repeat(70)}`)).toBe(161);
  });

  it('says which characters made a text message Unicode', () => {
    const findings = checkVersion(
      adapter,
      SMS,
      [seg('s1', 'She said “we are safe” – today')],
      briefWith('we are safe'),
    );
    const encoding = findings.find((f) => f.checkId === 'encoding');
    expect(encoding?.severity).toBe('warn');
    expect(encoding?.values?.characters).toBe('“ ” –');
  });
});

describe('links are matched whole', () => {
  const links = [
    { role: 'article' as const, label: 'Home', url: 'https://msf.org' },
    { role: 'donation' as const, label: 'Give', url: 'https://msf.org/donate' },
  ];
  const policy = { allowed: true, position: 'last' as const, cost: () => 0 };

  it('placing links twice gives the same text (one URL is a prefix of the other)', () => {
    const once = placeLinks(['Hello world'], links, policy);
    expect(placeLinks(once, links, policy)).toEqual(once);
  });

  it('leaves a longer link the user typed alone', () => {
    const text = 'See https://msf.org/donate/uk for the UK.';
    expect(stripLinks(text, links)).toBe(text);
  });

  it('finds a link before prose punctuation, and survives an empty url', () => {
    expect(linkRanges('Go to https://msf.org.', links)).toHaveLength(1);
    expect(linkRanges('anything', [{ url: '' }])).toEqual([]);
  });

  it('stays fast on a long run of spaces', () => {
    const started = Date.now();
    stripLinks(`${' '.repeat(180_000)}x`, links);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('a link that is not from the brief', () => {
  const brief = briefWith('Call us, or see msf.org/help for more.');

  it('blocks a full URL and only warns about a bare domain', () => {
    const findings = checkVersion(
      adapter,
      X,
      [seg('s1', 'Donate at https://evil.example/give or see report.pdf')],
      brief,
    ).filter((f) => f.checkId === 'link-grounded');
    expect(findings.map((f) => [f.severity, f.values?.url])).toEqual([
      ['block', 'https://evil.example/give'],
      ['warn', 'report.pdf'],
    ]);
  });

  it('accepts a link from the brief, and an address the brief itself states', () => {
    const withLink: Brief = {
      ...brief,
      links: [{ role: 'article', label: 'S', url: 'https://example.org/s' }],
    };
    const findings = checkVersion(
      adapter,
      X,
      [seg('s1', 'See msf.org/help.\n\nhttps://example.org/s')],
      withLink,
    );
    expect(findings.filter((f) => f.checkId === 'link-grounded')).toEqual([]);
  });
});

describe('suggestions may not make things worse', () => {
  const brief = briefWith('The clinic treated patients.');
  const fitting = [seg('s1', `${'word '.repeat(54)}end.`)];
  const guard = (candidate: Segment[]): number =>
    blockingScore(checkVersion(adapter, X, candidate, brief));
  const edit = (after: string) => ({
    segmentId: 's1',
    before: 'end.',
    after,
    reason: 'r',
  });

  it('drops one that pushes a fitting post over its hard limit', () => {
    expect(countText('x-weighted', fitting[0].text)).toBeLessThanOrEqual(280);
    expect(
      admissibleEdits(
        [edit('a much warmer and longer ending.')],
        fitting,
        brief,
        undefined,
        guard,
      ),
    ).toEqual([]);
    expect(
      admissibleEdits([edit('fin.')], fitting, brief, undefined, guard),
    ).toHaveLength(1);
  });

  it('drops one that adds a link the brief does not carry', () => {
    const short = [seg('s1', 'A short post end.')];
    expect(
      admissibleEdits(
        [edit('end. https://evil.example')],
        short,
        brief,
        undefined,
        guard,
      ),
    ).toEqual([]);
  });

  it('counts edits together: two that each fit alone cannot overflow as a pair', () => {
    const text = `${'word '.repeat(52)}one two`;
    const proposals = [
      { segmentId: 's1', before: 'one', after: 'one and then', reason: '' },
      { segmentId: 's1', before: 'two', after: 'two and more', reason: '' },
    ];
    expect(
      admissibleEdits(proposals, [seg('s1', text)], brief, undefined, guard),
    ).toHaveLength(1);
  });

  it('lets a cut through on a post that is already over', () => {
    const over = [seg('s1', `${'word '.repeat(60)}end.`)];
    expect(
      admissibleEdits([edit('.')], over, brief, undefined, guard),
    ).toHaveLength(1);
  });
});

describe('pending suggestions', () => {
  const brief = briefWith('We use clinics.');
  const base: Version = {
    ...emptyVersion('x'),
    segments: [seg('s1', 'Our teams utilise mobile clinics.')],
  };
  const proposal = {
    segmentId: 's1',
    before: 'utilise',
    after: 'use',
    reason: '',
  };

  it('are not wiped by an answer with nothing in it', () => {
    const withOne = landEdits(base, [proposal], brief, ['e1'], 'plainer');
    expect(pendingEdits(landEdits(withOne, [], brief, [], ''))).toHaveLength(1);
  });

  it('cannot be accepted into a quotation the text has since gained', () => {
    const quoteBrief: Brief = {
      ...brief,
      items: [
        {
          id: 'q',
          kind: 'quote',
          text: 'we use clean water every day',
          provenance: [],
          verified: 'verbatim',
          decision: 'included',
        },
      ],
    };
    const landed = landEdits(
      { ...base, segments: [seg('s1', 'They use clean water.')] },
      [
        {
          segmentId: 's1',
          before: 'clean water',
          after: 'safe water',
          reason: '',
        },
      ],
      quoteBrief,
      ['e1'],
      '',
    );
    const edited = setSegments(landed, [
      seg('s1', 'She said “we use clean water every day” to us.'),
    ]);
    const result = acceptEdit(edited, 'e1', NOW, quoteBrief);
    expect(result.segments[0].text).toContain('clean water');
    expect(result.edits?.[0].status).toBe('unapplicable');
  });
});

describe('staleness', () => {
  const generated = {
    specId: 'x',
    segments: [{ text: 'The clinic closed.', usedItemIds: ['i1'] }],
  };

  it('is stamped from the brief that was SENT, not the one at landing', () => {
    const sent = briefWith('The clinic closed');
    const now = briefWith('The clinic reopened');
    const version = applyGenerated(undefined, generated, sent, ['s1'], 'brief');
    expect(isStale(version, sent)).toBe(false);
    expect(isStale(version, now)).toBe(true);
  });

  it('a proposal that waited keeps the digest of the brief it was written from', () => {
    const sent = briefWith('The clinic closed');
    const now = briefWith('The clinic reopened');
    const existing = applyGenerated(
      undefined,
      { ...generated, segments: [{ text: 'Old words.', usedItemIds: ['i1'] }] },
      sent,
      ['s0'],
      'brief',
    );
    const proposed = applyGenerated(existing, generated, sent, ['s1'], 'brief');
    expect(isStale(useProposed(proposed, now, NOW), now)).toBe(true);
  });

  it('the same words again are not offered as a new version', () => {
    const brief = briefWith('The clinic closed');
    const existing = applyGenerated(
      undefined,
      generated,
      brief,
      ['s1'],
      'brief',
    );
    expect(
      applyGenerated(existing, generated, brief, ['s2'], 'brief').proposed,
    ).toBeUndefined();
  });

  it('restoring brings back what the words rested on, and is not stale at once', () => {
    const brief = briefWith('The clinic closed');
    const first = applyGenerated(undefined, generated, brief, ['s1'], 'brief');
    const second = useProposed(
      applyGenerated(
        first,
        { ...generated, segments: [{ text: 'Other words.', usedItemIds: [] }] },
        brief,
        ['s2'],
        'brief',
      ),
      brief,
      NOW,
    );
    const restored = restoreSnapshot(second, second.history[0], ['s3'], NOW);
    expect(restored.segments[0].usedItemIds).toEqual(['i1']);
    expect(isStale(restored, brief)).toBe(false);
    expect(approveVersion(restored, NOW).approval).toBeDefined();
  });
});

describe('images are never dropped', () => {
  const image = (id: string): MediaAttachment => ({
    id,
    ref: id,
    name: id,
    alt: 'a',
  });

  it('thirteen images over two posts are still thirteen on one', () => {
    const previous = [
      {
        ...seg('a', 'one'),
        media: Array.from({ length: 6 }, (_, i) => image(`a${i}`)),
      },
      {
        ...seg('b', 'two'),
        media: Array.from({ length: 7 }, (_, i) => image(`b${i}`)),
      },
    ];
    const next = carryMedia(previous, [seg('n', 'all in one')]);
    expect(next[0].media).toHaveLength(13);
  });
});

describe('overflow goes to the next post when it has room', () => {
  const options = {
    rule: 'graphemes' as const,
    limit: 60,
    numbered: false,
    maxSegments: 5,
  };

  it('does not grow a one-sentence post', () => {
    const segments = [
      seg(
        'a',
        'First sentence is here and it is long. Second one runs over the limit.',
      ),
      seg('b', 'Short.'),
    ];
    const result = pushOverflowForward(segments, 'a', options);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('First sentence is here and it is long.');
    expect(result[1].text).toBe('Second one runs over the limit. Short.');
  });

  it('declines when the next post has no room, so a new post is made instead', () => {
    const segments = [
      seg(
        'a',
        'First sentence is here and it is long. Second one runs over the limit.',
      ),
      seg('b', 'This next post is already quite full of its own words.'),
    ];
    expect(pushOverflowForward(segments, 'a', options)).toBe(segments);
  });
});
