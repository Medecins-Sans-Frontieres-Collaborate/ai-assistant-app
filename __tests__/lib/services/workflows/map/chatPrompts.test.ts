import {
  CompactMapFeature,
  MAP_CHAT_MUTATIONS_SCHEMA,
  MAP_EDIT_SENTINEL,
  buildMapChatSystemPrompt,
  buildMapDigest,
} from '@/lib/services/workflows/map/chatPrompts';

import { describe, expect, it } from 'vitest';

const feature = (
  name: string,
  overrides: Partial<CompactMapFeature> = {},
): CompactMapFeature => ({
  name,
  lat: 10.5,
  lon: -66.9,
  category: 'city',
  granularity: 'city',
  prominence: 'primary',
  confidence: 'high',
  description: 'desc',
  ...overrides,
});

describe('buildMapDigest', () => {
  it('includes header aggregates and full detail lines', () => {
    const digest = buildMapDigest([
      feature('Caracas', { eventStart: '2026-06-24' }),
      feature('La Guaira', { category: 'incident' }),
    ]);
    expect(digest).toContain('MAPPED DATA: 2 locations.');
    expect(digest).toContain('city: 1');
    expect(digest).toContain('incident: 1');
    expect(digest).toContain('Date range: 2026-06-24 to 2026-06-24.');
    expect(digest).toContain('Caracas|city|city||10.50,-66.90|2026-06-24');
  });

  it('tiers beyond the full-line limit and states the omission', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      feature(`Place ${i}`, {
        prominence: i < 10 ? 'primary' : 'mention',
      }),
    );
    const digest = buildMapDigest(many);
    expect(digest).toContain('only the 400 most important locations');
    expect(digest).toContain('100 more appear as');
    expect(digest).toContain('Additional locations (name|category|lat,lon):');
    // Primaries always land in the full tier.
    expect(digest).toContain('Place 0|city|city|');
  });

  it('orders primaries before mentions in the full tier', () => {
    const digest = buildMapDigest([
      feature('Aside', { prominence: 'mention' }),
      feature('Main', { prominence: 'primary' }),
    ]);
    expect(digest.indexOf('Main|')).toBeLessThan(digest.indexOf('Aside|'));
  });

  it('handles zero features', () => {
    const digest = buildMapDigest([]);
    expect(digest).toContain('MAPPED DATA: 0 locations.');
  });
});

describe('map chat prompts/schema', () => {
  it('the system prompt binds the sentinel contract', () => {
    expect(buildMapChatSystemPrompt()).toContain(MAP_EDIT_SENTINEL);
  });

  it('mutations schema is strict and requires both arrays', () => {
    expect(MAP_CHAT_MUTATIONS_SCHEMA.required).toEqual([
      'addFeatures',
      'addConnections',
    ]);
    expect(MAP_CHAT_MUTATIONS_SCHEMA.additionalProperties).toBe(false);
  });
});
