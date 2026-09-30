import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  applyChannelRule,
  channelsOfSet,
  defaultVoicesOfSet,
  forkChannelSetData,
  pickChannelSet,
  publishRuleName,
  virtualDefaultSet,
} from '@/lib/utils/shared/drafter/channels/channelSets';

import { ChannelSetData } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const x = getChannelProfile('x')!;
const linkedin = getChannelProfile('linkedin')!;

const norway: ChannelSetData = {
  name: 'MSF Norge',
  language: 'Norwegian',
  description: '',
  channels: {
    x: {
      enabled: true,
      guidance: 'Skriv kort.',
      hashtags: { max: 1, placement: 'end' },
      linkPosition: 'first',
      defaultVoiceGuideId: 'guide-norsk',
      publishTarget: 'hs-no-x',
    },
    linkedin: { enabled: false },
  },
  defaults: { channelIds: ['x'], articleLink: false, guideIds: [] },
  isDefault: false,
};

describe('a set over the platforms', () => {
  it('keeps the platform facts and takes the team rules', () => {
    const merged = applyChannelRule(x, norway.channels.x);
    expect(merged.segmentLimit).toBe(x.segmentLimit);
    expect(merged.counting).toBe(x.counting);
    expect(merged.maxSegments).toBe(x.maxSegments);
    expect(merged.guidance).toBe('Skriv kort.');
    expect(merged.hashtags).toEqual({ max: 1, placement: 'end' });
    expect(merged.links).toEqual({ allowed: true, position: 'first' });
    expect(merged.publishTarget).toBe('hs-no-x');
  });

  it('falls back to the platform for anything a rule leaves out', () => {
    const merged = applyChannelRule(
      { ...x, publishTarget: 'hs-global' },
      { enabled: true, guidance: '   ' },
    );
    expect(merged.guidance).toBe(x.guidance);
    expect(merged.hashtags).toEqual(x.hashtags);
    // The platform's Hootsuite profile stands in when the rule names none.
    expect(merged.publishTarget).toBe('hs-global');
  });

  it("a rule's Hootsuite profile wins over the platform's", () => {
    const merged = applyChannelRule(
      { ...x, publishTarget: 'hs-global' },
      { enabled: true, publishTarget: 'hs-no-x' },
    );
    expect(merged.publishTarget).toBe('hs-no-x');
  });

  it('carries no Hootsuite profile when neither names one', () => {
    const merged = applyChannelRule(x, { enabled: true });
    expect('publishTarget' in merged).toBe(false);
  });

  it('offers only the platforms the set lists and enables, in platform order', () => {
    const offered = channelsOfSet(norway, [linkedin, x]);
    expect(offered.map((profile) => profile.id)).toEqual(['x']);
    expect(defaultVoicesOfSet(norway)).toEqual({ x: 'guide-norsk' });
  });

  it('the implicit default offers every platform as it is', () => {
    const offered = channelsOfSet(virtualDefaultSet([linkedin, x]), [
      linkedin,
      x,
    ]);
    expect(offered).toEqual([linkedin, x]);
  });

  it('forks without sharing anything mutable', () => {
    const fork = forkChannelSetData(norway, 'MSF Norge Fundraising');
    expect(fork.name).toBe('MSF Norge Fundraising');
    expect(fork.isDefault).toBe(false);
    fork.channels.x.guidance = 'changed';
    fork.defaults.channelIds.push('linkedin');
    expect(norway.channels.x.guidance).toBe('Skriv kort.');
    expect(norway.defaults.channelIds).toEqual(['x']);
  });

  it("forks without the source team's Hootsuite profiles", () => {
    const fork = forkChannelSetData(norway, 'MSF Norge Fundraising');
    expect('publishTarget' in fork.channels.x).toBe(false);
    // Everything else about the rule comes along.
    expect(fork.channels.x).toEqual({
      enabled: true,
      guidance: 'Skriv kort.',
      hashtags: { max: 1, placement: 'end' },
      linkPosition: 'first',
      defaultVoiceGuideId: 'guide-norsk',
    });
    expect(norway.channels.x.publishTarget).toBe('hs-no-x');
  });

  it('names publish rules per set and channel', () => {
    expect(publishRuleName('set-abc', 'x')).toBe('set-abc/x');
  });
});

describe('which set a user lands in', () => {
  const sets = [
    {
      id: 'default',
      name: 'Default',
      isDefault: false,
      grant: 'everyone' as const,
    },
    {
      id: 'set-no',
      name: 'Norway',
      isDefault: false,
      grant: 'domain' as const,
    },
    { id: 'set-team', name: 'Team', isDefault: false, grant: 'user' as const },
    {
      id: 'set-pref',
      name: 'Preferred',
      isDefault: true,
      grant: 'everyone' as const,
    },
  ];

  it('is the one they used last, when they still may', () => {
    expect(pickChannelSet(sets, 'set-no')?.id).toBe('set-no');
    expect(pickChannelSet(sets, 'set-gone')?.id).toBe('set-team');
  });

  it('otherwise the most specifically shared, then the admin default, then the built-in', () => {
    expect(pickChannelSet(sets)?.id).toBe('set-team');
    expect(pickChannelSet(sets.slice(0, 2))?.id).toBe('set-no');
    expect(pickChannelSet([sets[0], sets[3]])?.id).toBe('set-pref');
    expect(pickChannelSet([sets[0]])?.id).toBe('default');
    expect(pickChannelSet([])).toBeNull();
  });
});
