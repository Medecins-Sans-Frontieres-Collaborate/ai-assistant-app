import {
  isModelSelectableInRegion,
  resolveChatRegion,
} from '@/lib/utils/shared/modelRegion';

import { describe, expect, it } from 'vitest';

describe('isModelSelectableInRegion', () => {
  it('treats models without hostedIn (static list / fallback) as selectable', () => {
    expect(isModelSelectableInRegion({}, 'US')).toBe(true);
    expect(isModelSelectableInRegion({ hostedIn: undefined }, 'EU')).toBe(true);
  });

  it('treats an empty hostedIn as selectable (defensive)', () => {
    expect(isModelSelectableInRegion({ hostedIn: [] }, 'US')).toBe(true);
  });

  it('is permissive while the session region is unknown', () => {
    expect(isModelSelectableInRegion({ hostedIn: ['EU'] }, null)).toBe(true);
    expect(isModelSelectableInRegion({ hostedIn: ['EU'] }, undefined)).toBe(
      true,
    );
  });

  it('US users can use any model (cross-region routing)', () => {
    expect(isModelSelectableInRegion({ hostedIn: ['EU'] }, 'US')).toBe(true);
    expect(isModelSelectableInRegion({ hostedIn: ['US'] }, 'US')).toBe(true);
    expect(isModelSelectableInRegion({ hostedIn: ['US', 'EU'] }, 'US')).toBe(
      true,
    );
  });

  it('EU users may only use EU-hosted models (residency)', () => {
    expect(isModelSelectableInRegion({ hostedIn: ['US'] }, 'EU')).toBe(false);
    expect(isModelSelectableInRegion({ hostedIn: ['EU'] }, 'EU')).toBe(true);
    expect(isModelSelectableInRegion({ hostedIn: ['US', 'EU'] }, 'EU')).toBe(
      true,
    );
  });
});

describe('resolveChatRegion', () => {
  it('ALWAYS forces EU users to EU, whatever the client requested', () => {
    expect(resolveChatRegion('EU', undefined)).toBe('EU');
    expect(resolveChatRegion('EU', 'US')).toBe('EU');
    expect(resolveChatRegion('EU', 'EU')).toBe('EU');
  });

  it('US users get their requested region', () => {
    expect(resolveChatRegion('US', 'EU')).toBe('EU');
    expect(resolveChatRegion('US', 'US')).toBe('US');
  });

  it('no preference → null (default client set, pre-cross-region behavior)', () => {
    expect(resolveChatRegion('US', undefined)).toBeNull();
    expect(resolveChatRegion('US', null)).toBeNull();
    expect(resolveChatRegion(null, undefined)).toBeNull();
    expect(resolveChatRegion(undefined, 'EU')).toBe('EU');
  });
});
