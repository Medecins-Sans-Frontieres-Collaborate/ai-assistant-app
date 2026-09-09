import {
  OpenAIModels,
  PRICING_ASSUMPTIONS_VERSION,
  PRICING_AS_OF,
} from '@/types/openai';

import { describe, expect, it } from 'vitest';

/**
 * Drift guard for the pricing metadata in config/models.json. The limits
 * admin's cost insights price every catalog model; an entry without
 * `pricing` silently shows "no price data", so a new model must either carry
 * a rate or be listed here on purpose. The per-model `confidence` /
 * `billing` / `alias` fields are the machine-readable form of the
 * `$pricing-note` prose — the two must not disagree.
 */

/** Catalog ids deliberately shipped without a list price. Empty today. */
const UNPRICED_ALLOWLIST: ReadonlySet<string> = new Set<string>();

describe('config/models.json pricing metadata', () => {
  const models = Object.values(OpenAIModels);
  /**
   * The models the rate / billing / provenance invariants run over. An
   * allowlisted model carries no `pricing` by design, so the invariants must
   * SKIP it rather than dereference `undefined` — otherwise the allowlist
   * cannot be used as documented above without editing four other tests.
   * Only allowlisted ids are skipped: an unlisted unpriced model still fails
   * the first test, and would fail here too.
   */
  const priced = models.filter(
    (
      m,
    ): m is (typeof models)[number] & {
      pricing: NonNullable<(typeof models)[number]['pricing']>;
    } => !UNPRICED_ALLOWLIST.has(m.id) && m.pricing !== undefined,
  );

  it('gives every catalog model a price unless it is explicitly allowlisted', () => {
    const unpriced = models
      .filter((m) => !m.pricing && !UNPRICED_ALLOWLIST.has(m.id))
      .map((m) => m.id);
    expect(unpriced).toEqual([]);
  });

  it('keeps the allowlist honest (no stale entries)', () => {
    for (const id of UNPRICED_ALLOWLIST) {
      expect(
        OpenAIModels[id as keyof typeof OpenAIModels]?.pricing,
      ).toBeUndefined();
    }
  });

  it('records finite, non-negative rates with input ≤ output', () => {
    for (const m of priced) {
      const p = m.pricing;
      expect(Number.isFinite(p.inputPer1M), m.id).toBe(true);
      expect(Number.isFinite(p.outputPer1M), m.id).toBe(true);
      expect(p.inputPer1M, m.id).toBeGreaterThanOrEqual(0);
      expect(p.outputPer1M, m.id).toBeGreaterThanOrEqual(p.inputPer1M);
      if (p.cachedInputPer1M !== undefined) {
        expect(p.cachedInputPer1M, m.id).toBeLessThanOrEqual(p.inputPer1M);
      }
    }
  });

  it('marks every Anthropic (Marketplace-billed) model billing: marketplace, and nothing else', () => {
    for (const m of priced) {
      const expected =
        m.sdk === 'anthropic-foundry' ? 'marketplace' : undefined;
      expect(m.pricing.billing, m.id).toBe(expected);
    }
  });

  it('flags exactly the no-retail-meter models as serverless-legacy', () => {
    const legacy = priced
      .filter((m) => m.pricing.confidence === 'serverless-legacy')
      .map((m) => m.id)
      .sort();
    expect(legacy).toEqual(
      [
        'DeepSeek-R1-0528',
        'Llama-4-Scout-17B-16E-Instruct',
        'Ministral-3B',
        'mistral-medium-2505',
        'mistral-small-2503',
      ].sort(),
    );
  });

  it('flags the rolling alias', () => {
    const aliases = priced.filter((m) => m.pricing.alias).map((m) => m.id);
    expect(aliases).toEqual(['gpt-chat-latest']);
  });

  it('exposes the pricing provenance as an ISO date and a version', () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(PRICING_AS_OF))).toBe(false);
    expect(PRICING_ASSUMPTIONS_VERSION).toMatch(/^\d{4}-\d{2}\.\d+$/);
  });
});
