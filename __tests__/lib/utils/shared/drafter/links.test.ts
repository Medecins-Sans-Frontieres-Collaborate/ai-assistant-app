import {
  checkVersion,
  getSpecAdapter,
} from '@/lib/utils/shared/drafter/adapters';
import { channelLinkPolicy } from '@/lib/utils/shared/drafter/channels/channelAdapter';
import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  MAX_LINK_URL_CHARS,
  briefLink,
  emptyBrief,
  isHttpUrl,
  normalizeHttpUrl,
  sameHttpUrl,
  setBriefLink,
} from '@/lib/utils/shared/drafter/core/brief';
import {
  DEFAULT_LINK_POLICY,
  linksCost,
  placeLinks,
  stripLinks,
} from '@/lib/utils/shared/drafter/core/links';
import {
  applyGenerated,
  isStale,
} from '@/lib/utils/shared/drafter/core/versions';

import { Brief, BriefLink, Segment } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const ARTICLE: BriefLink = {
  role: 'article',
  label: 'Statement on the water crisis',
  url: 'https://example.org/statements/water-crisis',
};
const DONATE: BriefLink = {
  role: 'donation',
  label: 'Donate',
  url: 'https://example.org/donate',
};

function seg(id: string, text: string): Segment {
  return { id, text, usedItemIds: [] };
}

describe('brief links', () => {
  it('keeps one link per role, the ask for donations last', () => {
    let brief = setBriefLink(emptyBrief(), 'donation', DONATE);
    brief = setBriefLink(brief, 'article', ARTICLE);
    brief = setBriefLink(brief, 'article', { ...ARTICLE, label: 'Renamed' });
    expect(brief.links.map((link) => link.role)).toEqual([
      'article',
      'donation',
    ]);
    expect(briefLink(brief, 'article')?.label).toBe('Renamed');
  });

  it('refuses anything that is not a web address', () => {
    const brief = emptyBrief();
    for (const url of ['javascript:alert(1)', 'example.org/donate', '']) {
      expect(setBriefLink(brief, 'donation', { label: 'x', url })).toBe(brief);
    }
  });

  it('refuses an address that hides a second one behind a line break', () => {
    // `new URL` silently drops the newline, so the raw string "validates"
    // while publishing as two links.
    const brief = emptyBrief();
    for (const url of [
      'https://msf.org/a\nhttps://evil.example/x',
      'https://msf.org/a\thttps://evil.example/x',
      'https://msf.org/a https://evil.example/x',
      'https://msf.org/a\u0000b',
      'https://msf.org/a\u2028b',
      `https://msf.org/${'a'.repeat(MAX_LINK_URL_CHARS)}`,
    ]) {
      expect(normalizeHttpUrl(url)).toBeNull();
      expect(isHttpUrl(url)).toBe(false);
      expect(setBriefLink(brief, 'donation', { label: 'x', url })).toBe(brief);
    }
  });

  it('stores the parsed form of the address, not what was typed', () => {
    expect(normalizeHttpUrl('  HTTPS://MSF.org  ')).toBe('https://msf.org/');
    expect(normalizeHttpUrl('ftp://msf.org/')).toBeNull();
    const brief = setBriefLink(emptyBrief(), 'donation', {
      label: 'Donate',
      url: ' https://MSF.org/donate ',
    });
    expect(briefLink(brief, 'donation')?.url).toBe('https://msf.org/donate');
    // The same address typed differently is not a change.
    expect(
      setBriefLink(brief, 'donation', {
        label: 'Donate',
        url: 'https://msf.org/donate',
      }),
    ).toBe(brief);
    expect(sameHttpUrl('https://MSF.org', 'https://msf.org/')).toBe(true);
    expect(sameHttpUrl('nope', 'nope')).toBe(false);
  });

  it('never assumes donations: a fresh brief carries no links', () => {
    expect(emptyBrief().links).toEqual([]);
  });

  it('removing a link that is not there changes nothing', () => {
    const brief = emptyBrief();
    expect(setBriefLink(brief, 'donation', null)).toBe(brief);
  });

  it('marks written versions stale when a link is switched on or off', () => {
    const brief: Brief = { ...emptyBrief(), keyMessage: 'Water is life' };
    const version = applyGenerated(
      undefined,
      { specId: 'x', segments: [{ text: 'A post.', usedItemIds: [] }] },
      brief,
      ['s1'],
      'first',
    );
    expect(isStale(version, brief)).toBe(false);
    const withAsk = setBriefLink(brief, 'donation', DONATE);
    expect(isStale(version, withAsk)).toBe(true);
    expect(isStale(version, setBriefLink(withAsk, 'donation', null))).toBe(
      false,
    );
  });
});

describe('placing links', () => {
  it('appends to the last post of a thread, each link on its own line', () => {
    expect(
      placeLinks(['First post.', 'Last post.'], [ARTICLE, DONATE], {
        ...DEFAULT_LINK_POLICY,
      }),
    ).toEqual(['First post.', `Last post.\n\n${ARTICLE.url}\n\n${DONATE.url}`]);
  });

  it('removes a URL the model wrote anyway, wherever it put it', () => {
    const placed = placeLinks(
      [`Read ${ARTICLE.url} now.`, 'The end.'],
      [ARTICLE],
      DEFAULT_LINK_POLICY,
    );
    expect(placed[0]).toBe('Read now.');
    expect(placed[1]).toBe(`The end.\n\n${ARTICLE.url}`);
  });

  it('is idempotent, so "Update" never doubles a link', () => {
    const once = placeLinks(['Post.'], [ARTICLE], DEFAULT_LINK_POLICY);
    expect(placeLinks(once, [ARTICLE], DEFAULT_LINK_POLICY)).toEqual(once);
  });

  it('appends nothing where links are not clickable', () => {
    const instagram = channelLinkPolicy(getChannelProfile('instagram')!);
    expect(placeLinks(['Caption.'], [ARTICLE], instagram)).toEqual([
      'Caption.',
    ]);
    expect(linksCost([ARTICLE], instagram)).toBe(0);
  });

  it('costs a flat 23 plus its two line breaks on X, full length elsewhere', () => {
    const x = channelLinkPolicy(getChannelProfile('x')!);
    const linkedin = channelLinkPolicy(getChannelProfile('linkedin')!);
    expect(linksCost([ARTICLE], x)).toBe(25);
    expect(linksCost([ARTICLE], linkedin)).toBe(ARTICLE.url.length + 2);
    expect(linksCost([ARTICLE, DONATE], x)).toBe(50);
  });

  it('strips links without leaving gaps', () => {
    expect(
      stripLinks(`Text.\n\n${ARTICLE.url}\n\n${DONATE.url}`, [ARTICLE, DONATE]),
    ).toBe('Text.');
  });
});

describe('link warnings', () => {
  const adapter = getSpecAdapter('channel')!;
  const x = getChannelProfile('x')!;
  const brief: Brief = { ...emptyBrief(), links: [ARTICLE] };
  const linkFindings = (segments: Segment[], with_: Brief = brief) =>
    checkVersion(adapter, x, segments, with_).filter(
      (finding) => finding.checkId === 'brief-links',
    );

  it('is quiet when the link sits in the last post', () => {
    expect(
      linkFindings([seg('a', 'One.'), seg('b', `Two.\n\n${ARTICLE.url}`)]),
    ).toEqual([]);
  });

  it('warns when an edit dropped the link', () => {
    expect(linkFindings([seg('a', 'One.'), seg('b', 'Two.')])).toEqual([
      expect.objectContaining({
        severity: 'warn',
        messageKey: 'articleLinkMissing',
        targetId: 'b',
        values: { post: 2 },
      }),
    ]);
  });

  it('warns when a split left the link mid-thread', () => {
    expect(
      linkFindings([seg('a', `One.\n\n${ARTICLE.url}`), seg('b', 'Two.')]),
    ).toEqual([
      expect.objectContaining({
        messageKey: 'linkNotInLastPost',
        targetId: 'a',
      }),
    ]);
  });

  it('names the donation link when that is the one missing', () => {
    expect(
      linkFindings([seg('a', 'One.')], { ...emptyBrief(), links: [DONATE] }),
    ).toEqual([expect.objectContaining({ messageKey: 'donationLinkMissing' })]);
  });

  it('asks for nothing on a channel that cannot carry links', () => {
    const findings = checkVersion(
      adapter,
      getChannelProfile('instagram')!,
      [seg('a', 'Caption. Link in bio.')],
      brief,
    );
    expect(findings.filter((f) => f.checkId === 'brief-links')).toEqual([]);
  });
});
