import {
  EvaluateAccess,
  evaluatePublishAccess,
} from '@/lib/services/workflows/channelDrafter/publishAccess';

import { describe, expect, it } from 'vitest';

type Rules = Record<string, { decision: string; reason: string }>;

/** An engine that answers from a table, and "no rule = allow" otherwise. */
function engine(rules: Rules): EvaluateAccess {
  return ({ source, agentName }) =>
    rules[`${source}::${agentName}`] ?? {
      decision: 'allow',
      reason: 'no-rule',
    };
}

const ALLOW_USER = { decision: 'allow', reason: 'allow-user' };
const DENIED = { decision: 'deny', reason: 'not-allowed' };

describe('evaluatePublishAccess', () => {
  it('denies everyone when no admin has granted anything', () => {
    expect(
      evaluatePublishAccess(engine({}), 'a@example.org', 'linkedin'),
    ).toEqual({ allowed: false, reason: 'no-grant' });
  });

  it('denies when the access subsystem is off, where no rule can exist', () => {
    const off: EvaluateAccess = () => ({
      decision: 'allow',
      reason: 'feature-disabled',
    });
    expect(
      evaluatePublishAccess(off, 'a@example.org', 'linkedin').allowed,
    ).toBe(false);
  });

  it('grants through a rule for that channel', () => {
    const result = evaluatePublishAccess(
      engine({ 'publish::linkedin': ALLOW_USER }),
      'a@example.org',
      'linkedin',
    );
    expect(result).toEqual({ allowed: true, reason: 'channel:allow-user' });
  });

  it('grants through the all-channels rule when the channel has none', () => {
    const result = evaluatePublishAccess(
      engine({ 'publish::*': { decision: 'allow', reason: 'allow-group' } }),
      'a@example.org',
      'x',
    );
    expect(result).toEqual({ allowed: true, reason: 'all:allow-group' });
  });

  it('lets a channel’s own rule decide alone, even against a wider grant', () => {
    const result = evaluatePublishAccess(
      engine({ 'publish::x': DENIED, 'publish::*': ALLOW_USER }),
      'a@example.org',
      'x',
    );
    expect(result.allowed).toBe(false);
  });

  it('grants nothing when the engine cannot decide', () => {
    const result = evaluatePublishAccess(
      engine({
        'publish::x': {
          decision: 'unavailable',
          reason: 'group-membership-degraded',
        },
      }),
      'a@example.org',
      'x',
    );
    expect(result.allowed).toBe(false);
  });

  it('honours an explicit "everyone" rule, which an admin did write', () => {
    const result = evaluatePublishAccess(
      engine({ 'publish::*': { decision: 'allow', reason: 'public' } }),
      undefined,
      'bluesky',
    );
    expect(result.allowed).toBe(true);
  });
});

describe('owning a set covers its sending rules', () => {
  it('maps publish::<set>/<channel> to channel-set::<set>, and nothing else', async () => {
    const { owningKeyOf } =
      await import('@/lib/services/agentAccess/adminAuth');
    const { canEditKey } =
      await import('@/lib/services/agentAccess/adminRouteHelpers');
    expect(owningKeyOf('publish::set-abc/x')).toBe('channel-set::set-abc');
    expect(owningKeyOf('publish::*')).toBeNull();
    expect(owningKeyOf('channel-set::set-abc')).toBeNull();
    const owner = {
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['channel-set::set-abc'],
    };
    expect(canEditKey(owner, 'publish::set-abc/x')).toBe(true);
    expect(canEditKey(owner, 'publish::set-other/x')).toBe(false);
    expect(canEditKey(owner, 'publish::*')).toBe(false);
  });
});
