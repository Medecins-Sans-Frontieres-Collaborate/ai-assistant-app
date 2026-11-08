import {
  THROUGHPUT_CACHE_TTL_MS,
  resetThroughputCacheForTests,
  resolveServingTokensPerMinute,
  warmServingThroughput,
} from '@/lib/services/models/deploymentThroughput';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discoverServedModels = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/models/servedModels', () => ({
  discoverServedModels,
}));

const servedAt = (astraTpm: number) => ({
  source: 'discovery',
  models: [{ id: 'gpt-6-astra', tokensPerMinute: astraTpm }, { id: 'gpt-5.4' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  resetThroughputCacheForTests();
  discoverServedModels.mockResolvedValue(servedAt(250000));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveServingTokensPerMinute', () => {
  it('reads the TPM stamped on the served entry for the region', async () => {
    await expect(
      resolveServingTokensPerMinute('gpt-6-astra', 'EU'),
    ).resolves.toBe(250000);
    expect(discoverServedModels).toHaveBeenCalledWith('EU');
  });

  it('is undefined for a served model without a ceiling', async () => {
    await expect(
      resolveServingTokensPerMinute('gpt-5.4', 'US'),
    ).resolves.toBeUndefined();
  });

  it('is undefined for a model the region does not serve', async () => {
    await expect(
      resolveServingTokensPerMinute('gpt-6.1-sol', 'US'),
    ).resolves.toBeUndefined();
  });

  it('fails soft when discovery throws', async () => {
    discoverServedModels.mockRejectedValue(new Error('ARM down'));
    await expect(
      resolveServingTokensPerMinute('gpt-6-astra', 'US'),
    ).resolves.toBeUndefined();
  });

  it('gives up after the timeout instead of stalling the turn', async () => {
    discoverServedModels.mockReturnValue(new Promise(() => {}));
    await expect(
      resolveServingTokensPerMinute('gpt-6-astra', 'US', 5),
    ).resolves.toBeUndefined();
  });

  describe('per-region cache', () => {
    it('answers repeat turns from the cache without another discovery read', async () => {
      await resolveServingTokensPerMinute('gpt-6-astra', 'US');
      await resolveServingTokensPerMinute('gpt-6-astra', 'US');
      await resolveServingTokensPerMinute('gpt-5.4', 'US');
      expect(discoverServedModels).toHaveBeenCalledTimes(1);
    });

    it('keeps regions separate', async () => {
      await resolveServingTokensPerMinute('gpt-6-astra', 'US');
      await resolveServingTokensPerMinute('gpt-6-astra', 'EU');
      expect(discoverServedModels).toHaveBeenCalledTimes(2);
    });

    it('serves a slow first refresh to the next turn once it lands', async () => {
      let land: (value: unknown) => void = () => {};
      discoverServedModels.mockReturnValue(
        new Promise((resolve) => {
          land = resolve;
        }),
      );
      await expect(
        resolveServingTokensPerMinute('gpt-6-astra', 'US', 5),
      ).resolves.toBeUndefined();
      land(servedAt(250000));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(
        resolveServingTokensPerMinute('gpt-6-astra', 'US'),
      ).resolves.toBe(250000);
      expect(discoverServedModels).toHaveBeenCalledTimes(1);
    });

    it('serves a stale entry immediately and picks up a capacity raise after refresh', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await resolveServingTokensPerMinute('gpt-6-astra', 'US');

      // Just inside the TTL: no refresh.
      vi.setSystemTime(Date.now() + THROUGHPUT_CACHE_TTL_MS);
      await resolveServingTokensPerMinute('gpt-6-astra', 'US');
      expect(discoverServedModels).toHaveBeenCalledTimes(1);

      // Past the TTL: the stale value answers, a refresh starts.
      discoverServedModels.mockResolvedValue(servedAt(1000000));
      vi.setSystemTime(Date.now() + 1);
      await expect(
        resolveServingTokensPerMinute('gpt-6-astra', 'US'),
      ).resolves.toBe(250000);
      expect(discoverServedModels).toHaveBeenCalledTimes(2);

      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        resolveServingTokensPerMinute('gpt-6-astra', 'US'),
      ).resolves.toBe(1000000);
    });
  });
});

describe('warmServingThroughput (boot warm-up)', () => {
  it('lets the first turn after boot plan with its ceiling, even with a zero wait', async () => {
    warmServingThroughput(['US', 'EU']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A 0 ms budget would lose to any cold lookup; a warmed region answers.
    await expect(
      resolveServingTokensPerMinute('gpt-6-astra', 'EU', 0),
    ).resolves.toBe(250000);
    expect(discoverServedModels).toHaveBeenCalledTimes(2);
  });

  it('does not re-read a region that is already cached', async () => {
    await resolveServingTokensPerMinute('gpt-6-astra', 'US');
    warmServingThroughput(['US']);
    expect(discoverServedModels).toHaveBeenCalledTimes(1);
  });

  it('shares one store across module instances (instrumentation vs routes)', async () => {
    warmServingThroughput(['EU']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.resetModules();
    const fresh = await import('@/lib/services/models/deploymentThroughput');
    await expect(
      fresh.resolveServingTokensPerMinute('gpt-6-astra', 'EU', 0),
    ).resolves.toBe(250000);
  });
});
