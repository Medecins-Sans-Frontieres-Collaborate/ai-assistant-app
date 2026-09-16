/**
 * The beta carve-out for limits storage (lib/services/limits/types.ts): beta
 * shares prod's admin container, so its policy, counters and history live
 * under environment-suffixed names. Prod's names must never move.
 */
import {
  LIMITS_HISTORY_PREFIX,
  LIMITS_POLICY_PATH,
  LIMITS_USAGE_PREFIX,
  limitsBlobPaths,
  limitsBlobVariant,
} from '@/lib/services/limits/types';

import { describe, expect, it } from 'vitest';

describe('limitsBlobVariant', () => {
  it('is beta for the beta ring and its staging alias', () => {
    expect(limitsBlobVariant('beta')).toBe('beta');
    expect(limitsBlobVariant('staging')).toBe('beta');
  });

  it('is null for prod, dev, localhost and unset', () => {
    for (const env of ['prod', 'live', 'production', 'dev', 'localhost']) {
      expect(limitsBlobVariant(env)).toBeNull();
    }
    expect(limitsBlobVariant(undefined)).toBeNull();
  });
});

describe('limitsBlobPaths', () => {
  it('keeps the unsuffixed prod layout unchanged', () => {
    expect(limitsBlobPaths(null)).toEqual({
      policyPath: 'system/limits/policy.json',
      historyPrefix: 'system/limits/history/',
      usagePrefix: 'system/limits/usage/',
    });
  });

  it('suffixes the WHOLE dataset for beta — policy, history and counters', () => {
    expect(limitsBlobPaths('beta')).toEqual({
      policyPath: 'system/limits/policy.beta.json',
      historyPrefix: 'system/limits/history.beta/',
      usagePrefix: 'system/limits/usage.beta/',
    });
  });

  it('never lets one variant’s prefix match the other’s blobs', () => {
    const prod = limitsBlobPaths(null);
    const beta = limitsBlobPaths('beta');
    expect(beta.policyPath.startsWith(prod.historyPrefix)).toBe(false);
    expect(beta.policyPath.startsWith(prod.usagePrefix)).toBe(false);
    expect(beta.historyPrefix.startsWith(prod.historyPrefix)).toBe(false);
    expect(beta.usagePrefix.startsWith(prod.usagePrefix)).toBe(false);
    expect(prod.historyPrefix.startsWith(beta.historyPrefix)).toBe(false);
    expect(prod.usagePrefix.startsWith(beta.usagePrefix)).toBe(false);
  });

  it('exports the active constants from the same builder (test env is not beta)', () => {
    const active = limitsBlobPaths(limitsBlobVariant());
    expect(LIMITS_POLICY_PATH).toBe(active.policyPath);
    expect(LIMITS_HISTORY_PREFIX).toBe(active.historyPrefix);
    expect(LIMITS_USAGE_PREFIX).toBe(active.usagePrefix);
  });
});
