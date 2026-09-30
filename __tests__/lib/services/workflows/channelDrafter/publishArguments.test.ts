import { buildPublishArguments } from '@/lib/services/workflows/channelDrafter/publishArguments';

import {
  HOOTSUITE_PUBLISHING,
  HootsuitePublishingConfig,
  isPublishingConfigured,
} from '@/config/publishing';
import { describe, expect, it } from 'vitest';

const configured: HootsuitePublishingConfig = {
  catalogKey: 'hootsuitePerch',
  toolName: 'save_draft',
  textArgument: 'text',
  targetArgument: 'socialProfileIds',
  targetIsList: true,
  fixedArguments: { state: 'DRAFT' },
  allowVouched: false,
};

describe('publishing config', () => {
  it('ships dark: nothing is configured until someone fills in the tool', () => {
    expect(isPublishingConfigured(HOOTSUITE_PUBLISHING)).toBe(false);
    expect(HOOTSUITE_PUBLISHING.allowVouched).toBe(false);
  });

  it('needs both the tool and the text argument', () => {
    expect(isPublishingConfigured(configured)).toBe(true);
    expect(isPublishingConfigured({ ...configured, toolName: ' ' })).toBe(
      false,
    );
    expect(isPublishingConfigured({ ...configured, textArgument: '' })).toBe(
      false,
    );
  });
});

describe('buildPublishArguments', () => {
  it('sends the fixed arguments, the channel’s profile and the text, nothing else', () => {
    expect(
      buildPublishArguments(configured, 'The approved post.', {
        publishTarget: ' 12345 ',
      }),
    ).toEqual({
      ok: true,
      arguments: {
        state: 'DRAFT',
        socialProfileIds: ['12345'],
        text: 'The approved post.',
      },
    });
  });

  it('sends the profile as a plain value when the tool takes one', () => {
    const result = buildPublishArguments(
      { ...configured, targetIsList: false },
      'Post.',
      { publishTarget: '12345' },
    );
    expect(result).toEqual({
      ok: true,
      arguments: { state: 'DRAFT', socialProfileIds: '12345', text: 'Post.' },
    });
  });

  it('refuses a channel with no Hootsuite profile when the tool needs one', () => {
    expect(buildPublishArguments(configured, 'Post.', {})).toEqual({
      ok: false,
      reason: 'no-target',
    });
  });

  it('sends no target at all when the tool takes none', () => {
    expect(
      buildPublishArguments({ ...configured, targetArgument: '' }, 'Post.', {}),
    ).toEqual({ ok: true, arguments: { state: 'DRAFT', text: 'Post.' } });
  });

  it('never lets a fixed argument stand in for the approved text', () => {
    const result = buildPublishArguments(
      { ...configured, fixedArguments: { text: 'something else' } },
      'The approved post.',
      { publishTarget: '1' },
    );
    expect(result.ok && result.arguments.text).toBe('The approved post.');
  });
});
