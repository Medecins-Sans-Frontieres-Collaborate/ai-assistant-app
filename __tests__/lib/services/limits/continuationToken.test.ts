import {
  CONTINUATION_TOKEN_TTL_MS,
  isVerifiedContinuation,
  mintContinuationToken,
  verifyContinuationToken,
} from '@/lib/services/limits/continuationToken';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The limits middleware meters only round 0 of a tool loop. Whether a round
 * is a continuation must come from a server-signed token bound to the user
 * and the approval card, never from the client's round counter alone.
 */
describe('continuation token', () => {
  const NOW = 1_800_000_000_000;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'test-secret';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  });

  it('round-trips for the same user and approval id', () => {
    const token = mintContinuationToken('oid-1', 'call_1', NOW)!;
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
    expect(verifyContinuationToken('oid-1', 'call_1', token, NOW + 1000)).toBe(
      true,
    );
  });

  it('rejects another user, another card, a tampered signature, and expiry', () => {
    const token = mintContinuationToken('oid-1', 'call_1', NOW)!;
    expect(verifyContinuationToken('oid-2', 'call_1', token, NOW)).toBe(false);
    expect(verifyContinuationToken('oid-1', 'call_2', token, NOW)).toBe(false);
    expect(
      verifyContinuationToken('oid-1', 'call_1', `${token.slice(0, -1)}x`, NOW),
    ).toBe(false);
    expect(
      verifyContinuationToken(
        'oid-1',
        'call_1',
        token,
        NOW + CONTINUATION_TOKEN_TTL_MS + 1,
      ),
    ).toBe(false);
    expect(verifyContinuationToken('oid-1', 'call_1', undefined, NOW)).toBe(
      false,
    );
    expect(verifyContinuationToken('oid-1', 'call_1', 'v1.abc.def', NOW)).toBe(
      false,
    );
  });

  it('mints nothing without a secret, and verifies nothing either (metered, the safe direction)', () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(mintContinuationToken('oid-1', 'call_1', NOW)).toBeNull();
    expect(verifyContinuationToken('oid-1', 'call_1', 'v1.1.x', NOW)).toBe(
      false,
    );
  });

  describe('isVerifiedContinuation', () => {
    it('is false for a bare round counter — the original bypass', () => {
      expect(isVerifiedContinuation('oid-1', 1, undefined, 0, NOW)).toBe(false);
      expect(isVerifiedContinuation('oid-1', 1, [], 1, NOW)).toBe(false);
      expect(
        isVerifiedContinuation('oid-1', 1, [{ id: 'call_1' }], 1, NOW),
      ).toBe(false);
    });

    it('is true only when EVERY pending call carries a token that verifies', () => {
      const good = mintContinuationToken('oid-1', 'call_1', NOW)!;
      const other = mintContinuationToken('oid-2', 'call_2', NOW)!;
      expect(
        isVerifiedContinuation(
          'oid-1',
          1,
          [{ id: 'call_1', continuationToken: good }],
          1,
          NOW,
        ),
      ).toBe(true);
      expect(
        isVerifiedContinuation(
          'oid-1',
          1,
          [
            { id: 'call_1', continuationToken: good },
            { id: 'call_2', continuationToken: other },
          ],
          1,
          NOW,
        ),
      ).toBe(false);
      // Round 0 is never a continuation, token or not.
      expect(
        isVerifiedContinuation(
          'oid-1',
          0,
          [{ id: 'call_1', continuationToken: good }],
          1,
          NOW,
        ),
      ).toBe(false);
      // No servers → nothing to continue.
      expect(
        isVerifiedContinuation(
          'oid-1',
          1,
          [{ id: 'call_1', continuationToken: good }],
          0,
          NOW,
        ),
      ).toBe(false);
    });
  });
});
