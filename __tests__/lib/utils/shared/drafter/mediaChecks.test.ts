import {
  SUGGESTED_ALT_MAX_CHARS,
  normalizeAltText,
} from '@/lib/services/workflows/shared/drafter/altText';

import {
  checkVersion,
  getSpecAdapter,
} from '@/lib/utils/shared/drafter/adapters';
import { buildChannelPreview } from '@/lib/utils/shared/drafter/channels/channelPreview';
import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  ReviewPackLabels,
  buildReviewPack,
} from '@/lib/utils/shared/drafter/core/reviewPack';
import { emptyVersion } from '@/lib/utils/shared/drafter/core/versions';

import { BriefLink, MediaAttachment, Segment } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const REF = `/api/file/${'a'.repeat(64)}.jpg`;
const adapter = getSpecAdapter('channel')!;
const x = getChannelProfile('x')!;
const sms = getChannelProfile('sms')!;
const linkedin = getChannelProfile('linkedin')!;
const instagram = getChannelProfile('instagram')!;

function image(id: string, alt: string): MediaAttachment {
  return { id, ref: REF, name: `${id}.jpg`, alt };
}

function seg(text: string, media?: MediaAttachment[]): Segment {
  return { id: 's1', text, usedItemIds: [], ...(media ? { media } : {}) };
}

const mediaFindings = (profile: typeof x, segments: Segment[]) =>
  checkVersion(adapter, profile, segments, emptyBrief()).filter(
    (f) => f.checkId === 'alt-text' || f.checkId === 'media',
  );

describe('image checks', () => {
  it('blocks an image nobody has described, on every channel', () => {
    expect(
      mediaFindings(linkedin, [seg('Post.', [image('m1', '  ')])]),
    ).toEqual([
      expect.objectContaining({
        checkId: 'alt-text',
        severity: 'block',
        messageKey: 'altTextMissing',
        values: { name: 'm1.jpg', post: 1 },
      }),
    ]);
    expect(
      mediaFindings(linkedin, [seg('Post.', [image('m1', 'A clinic.')])]),
    ).toEqual([]);
  });

  it('blocks more images than the channel takes, and warns on long alt text', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => image(id, 'Described.'));
    expect(mediaFindings(x, [seg('Post.', five)])).toEqual([
      expect.objectContaining({
        severity: 'block',
        messageKey: 'tooManyImages',
        values: { count: 5, max: 4, post: 1 },
      }),
    ]);
    const long = mediaFindings(x, [
      seg('Post.', [image('m1', 'a'.repeat(1010))]),
    ]);
    expect(long).toEqual([
      expect.objectContaining({
        severity: 'warn',
        messageKey: 'altTooLong',
        values: { name: 'm1.jpg', count: 10, max: 1000 },
      }),
    ]);
  });

  it('says so when a channel carries no images at all', () => {
    expect(
      mediaFindings(sms, [seg('Text.', [image('m1', 'Described.')])]),
    ).toEqual([
      expect.objectContaining({
        severity: 'block',
        messageKey: 'imagesNotCarried',
      }),
    ]);
  });

  it('stays silent about image counts where the profile states none', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      image(`m${i}`, 'Described.'),
    );
    expect(mediaFindings(linkedin, [seg('Post.', many)])).toEqual([]);
  });
});

describe('preview: images and link cards', () => {
  const link: BriefLink = {
    role: 'article',
    label: 'Statement on the water crisis',
    url: 'https://www.example.org/statements/water',
  };

  it('shows attached images with their alt text', () => {
    const [post] = buildChannelPreview(x, [
      seg('Post.', [image('m1', 'A clinic.')]),
    ]);
    expect(post.media).toEqual([{ id: 'm1', ref: REF, alt: 'A clinic.' }]);
    expect(post.linkCards).toEqual([]);
  });

  it('cards a link the brief carries, with its title and host and nothing invented', () => {
    const [post] = buildChannelPreview(
      x,
      [seg(`Read it:\n\n${link.url}`)],
      [link],
    );
    expect(post.linkCards).toEqual([
      { title: 'Statement on the water crisis', host: 'example.org' },
    ]);
  });

  it('cards nothing for a link that is not in the post, or where links are not clickable', () => {
    expect(
      buildChannelPreview(x, [seg('No link here.')], [link])[0].linkCards,
    ).toEqual([]);
    expect(
      buildChannelPreview(instagram, [seg(`Caption ${link.url}`)], [link])[0]
        .linkCards,
    ).toEqual([]);
  });
});

describe('review pack: images', () => {
  const labels = {
    title: 'T',
    generated: 'G',
    brief: 'B',
    keyMessage: 'K',
    callToAction: 'C',
    links: 'L',
    linkRoles: { article: 'A', donation: 'D' },
    items: 'I',
    kinds: {
      quote: 'Q',
      testimony: 'T',
      fact: 'F',
      figure: 'Fi',
      context: 'Cx',
    },
    verification: { verbatim: 'V', 'user-asserted': 'U', unverified: 'N' },
    versions: 'Versions',
    post: (n: number) => `Post ${n}`,
    approved: () => 'Approved',
    notApproved: 'Not approved',
    approvalChanged: 'Changed',
    briefChanged: 'Brief changed',
    proof: () => 'proof',
    checks: 'Checks',
    provenance: 'P',
    provenanceColumns: ['a', 'b', 'c', 'd'],
    noSource: 'None',
    image: (name: string) => `Image (${name})`,
    altMissing: 'no alt text yet',
  } satisfies ReviewPackLabels;

  it('prints what each image says to those who cannot see it, or that it says nothing', () => {
    const state = {
      updatedAt: '',
      sources: [],
      brief: emptyBrief(),
      guideIds: [],
      specIds: ['x'],
      layout: { hidden: [], pinned: [] },
      nextId: 1,
      versions: { x: { ...emptyVersion('x'), segments: [seg('Post.')] } },
    };
    const pack = buildReviewPack(
      state,
      [
        {
          id: 'x',
          name: 'X',
          renderedTexts: ['Post.'],
          findings: [],
          findingMessages: [],
          media: [
            [
              { name: 'a.jpg', alt: 'A clinic at dawn.' },
              { name: 'b.jpg', alt: '' },
            ],
          ],
        },
      ],
      labels,
      'now',
    );
    expect(pack).toContain('- Image (a.jpg): A clinic at dawn.');
    expect(pack).toContain('- Image (b.jpg): _no alt text yet_');
  });
});

describe('normalizeAltText', () => {
  it('drops "Image of", collapses whitespace and caps the length', () => {
    expect(
      normalizeAltText({ alt: '  A photo of   a nurse\nfilling a jerrycan. ' }),
    ).toBe('A nurse filling a jerrycan.');
    expect(normalizeAltText({ alt: 'Image of a sign reading "Clinic".' })).toBe(
      'A sign reading "Clinic".',
    );
    expect(normalizeAltText({ alt: 'x'.repeat(900) })).toHaveLength(
      SUGGESTED_ALT_MAX_CHARS,
    );
    expect(normalizeAltText({} as never)).toBe('');
  });
});
