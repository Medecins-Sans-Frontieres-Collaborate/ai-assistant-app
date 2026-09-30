/**
 * Built-in channel profiles: what a platform IS, independent of who writes.
 *
 * One table drives everything about a channel: the prompt block, the
 * deterministic checks, the live counters, the thread splitter's budget and
 * the fold drawn in the text. There is no second source of truth.
 *
 * IMAGE RULES (`media`) are stated only where reasonably certain (four
 * images on X, Bluesky and Mastodon, and their alt text limits); a profile
 * without them is simply not checked for images. An admin can add or correct
 * them like any other limit.
 *
 * Limits are DATA THAT DRIFTS. Platforms change them without notice, which
 * is why admin-editable profiles follow (docs/CHANNEL_DRAFTER_DESIGN.md
 * §4.1); until then a change here is a one-line fix.
 */
import { ChannelProfile, ChannelSlot } from '@/types/drafter';

/** The opening line shown before a "see more" fold. */
function openingLine(maxChars: number): ChannelSlot {
  return {
    id: 'opening-line',
    labelKey: 'openingLine',
    maxChars,
    appliesTo: 'first-segment-first-line',
    foldLabelKey: 'seeMore',
  };
}

export const CHANNEL_PROFILES: ReadonlyArray<ChannelProfile> = [
  {
    id: 'linkedin',
    kind: 'channel',
    name: 'LinkedIn',
    family: 'social',
    maxSegments: 1,
    segmentLimit: 3000,
    // Counted strictly (code units): these editors are not documented to
    // count by grapheme, and over-counting never gets a post rejected.
    counting: 'utf16',
    slots: [openingLine(120)],
    hashtags: { max: 3, placement: 'end' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'none',
    guidance:
      'A professional audience reading between tasks. The first line is all ' +
      'most people see before "see more", so it must carry the point on its ' +
      'own. Short paragraphs separated by blank lines. One idea per ' +
      'paragraph. No more than three hashtags, at the end.',
  },
  {
    id: 'x',
    kind: 'channel',
    name: 'X',
    family: 'social',
    maxSegments: 25,
    segmentLimit: 280,
    counting: 'x-weighted',
    slots: [],
    hashtags: { max: 2, placement: 'inline' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'n/N',
    media: { maxImages: 4, altLimit: 1000 },
    guidance:
      'Fast, scannable. Each post must make sense read alone, because posts ' +
      'in a thread are shared individually. Lead the thread with the ' +
      'strongest human moment. At most two hashtags in the whole thread.',
  },
  {
    id: 'threads',
    kind: 'channel',
    name: 'Threads',
    family: 'social',
    maxSegments: 10,
    segmentLimit: 500,
    counting: 'graphemes',
    slots: [],
    hashtags: { max: 1, placement: 'end' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'n/N',
    guidance:
      'Conversational and personal, closer to speech than to a press line. ' +
      'Prefer one post; use a second only when the story needs it. At most ' +
      'one topic tag.',
  },
  {
    id: 'bluesky',
    kind: 'channel',
    name: 'Bluesky',
    family: 'social',
    maxSegments: 25,
    segmentLimit: 300,
    counting: 'graphemes',
    slots: [],
    hashtags: { max: 2, placement: 'end' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'n/N',
    media: { maxImages: 4, altLimit: 2000 },
    guidance:
      'Plain and direct; the audience is wary of marketing language. Each ' +
      'post must stand alone.',
  },
  {
    id: 'mastodon',
    kind: 'channel',
    name: 'Mastodon',
    family: 'social',
    maxSegments: 25,
    segmentLimit: 500,
    // Mastodon counts every link as 23, whatever its length.
    counting: 'url-23',
    slots: [],
    hashtags: { max: 4, placement: 'end' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'n/N',
    media: { maxImages: 4, altLimit: 1500 },
    guidance:
      'Discovery runs on hashtags, so use a few specific ones at the end, ' +
      'written in CamelCase so screen readers can read them. Informative ' +
      'over promotional.',
  },
  {
    id: 'facebook',
    kind: 'channel',
    name: 'Facebook',
    family: 'social',
    maxSegments: 1,
    segmentLimit: 5000,
    counting: 'graphemes',
    slots: [openingLine(125)],
    hashtags: { max: 2, placement: 'end' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'none',
    guidance:
      'A broad, general audience including supporters and families. Warm, ' +
      'story-led, in everyday words. The opening must work before "see ' +
      'more". Keep it well under the limit: a few short paragraphs.',
  },
  {
    id: 'instagram',
    kind: 'channel',
    name: 'Instagram caption',
    family: 'social',
    maxSegments: 1,
    segmentLimit: 2200,
    // Counted strictly (code units): these editors are not documented to
    // count by grapheme, and over-counting never gets a post rejected.
    counting: 'utf16',
    slots: [openingLine(125)],
    hashtags: { max: 5, placement: 'end' },
    links: { allowed: false, position: 'last' },
    threadNumbering: 'none',
    guidance:
      'A caption that accompanies an image. The first line is the hook ' +
      'shown beside the picture. Links are not clickable, so say "link in ' +
      'bio" instead of pasting one. Hashtags in a block at the end.',
  },
  // Non-social channels. The same table serves them: a channel is whatever
  // has a limit, a voice and a reader (design doc §4.1).
  {
    id: 'newsletter',
    kind: 'channel',
    name: 'Newsletter blurb',
    family: 'email',
    maxSegments: 1,
    segmentLimit: 900,
    counting: 'graphemes',
    slots: [],
    hashtags: { max: 0, placement: 'none' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'none',
    guidance:
      'One item among several in an email newsletter to supporters. A ' +
      'short headline on the first line, then two or three sentences that ' +
      'make someone want to read on. Readers chose to receive this, so be ' +
      'direct and warm; no hashtags, no emoji.',
  },
  {
    id: 'intranet',
    kind: 'channel',
    name: 'Intranet post',
    family: 'web',
    maxSegments: 1,
    segmentLimit: 2500,
    counting: 'graphemes',
    slots: [],
    hashtags: { max: 0, placement: 'none' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'none',
    guidance:
      'Colleagues across the organisation, many reading in a second ' +
      'language. A headline on the first line, then short paragraphs. Name ' +
      'teams and places plainly, avoid acronyms that only one department ' +
      'uses, and say what it means for staff.',
  },
  {
    id: 'sms',
    kind: 'channel',
    name: 'SMS',
    family: 'messaging',
    maxSegments: 1,
    // One GSM-7 message. A character outside that alphabet (emoji, curly
    // quotes, most non-Latin scripts) makes the whole message Unicode, with
    // room for 70; the `gsm7` rule counts that, and a check names the
    // characters responsible.
    segmentLimit: 160,
    counting: 'gsm7',
    slots: [],
    hashtags: { max: 0, placement: 'none' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'none',
    media: { maxImages: 0 },
    guidance:
      'A single text message. One sentence that stands completely on its ' +
      'own, from a named sender. No emoji, no hashtags, no quotation ' +
      'unless it is very short. If there is a link it is the whole point.',
  },
  {
    id: 'whatsapp',
    kind: 'channel',
    name: 'WhatsApp broadcast',
    family: 'messaging',
    maxSegments: 1,
    segmentLimit: 700,
    counting: 'graphemes',
    slots: [],
    hashtags: { max: 0, placement: 'none' },
    links: { allowed: true, position: 'last' },
    threadNumbering: 'none',
    guidance:
      'A message people receive beside those from family and friends. ' +
      'Personal, brief, in everyday words, a few short lines. It must not ' +
      'read like a press release. No hashtags.',
  },
];

const BY_ID = new Map(CHANNEL_PROFILES.map((profile) => [profile.id, profile]));

export function getChannelProfile(id: string): ChannelProfile | undefined {
  return BY_ID.get(id);
}

/** Whether the profile's posts are numbered when there is more than one. */
export function isNumbered(profile: ChannelProfile): boolean {
  return profile.threadNumbering === 'n/N';
}
