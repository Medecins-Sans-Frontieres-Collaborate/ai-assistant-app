import enMessages from '@/messages/en.json';
import { describe, expect, it } from 'vitest';

/**
 * Copy-conformance guard for the token-cap rule.
 *
 * The per-row hint (CostHint) and the preview's "spent so far" line
 * (spentSoFarUsd) both price a token counter at the HIGHEST blended $/token
 * among the allowed models — not at the model that is dearest per request,
 * which a reasoner's output multiplier can make priciest per request while it
 * carries a lower $/counted-token (limitsPricing.test.ts pins the arithmetic).
 * The review caught the copy describing a third rule ("the blended rate of
 * the priciest allowed model"), so the two strings that name the rule are
 * pinned here to the wording the code implements. Change the rule and the
 * copy together, or this fails.
 */
const cost = enMessages.limits.cost;
const RULE = 'the highest blended rate among allowed models';
const STALE = /priciest allowed model/;

describe('limits.cost token-cap copy', () => {
  it('upToTokens names the max-blended rule the hint implements', () => {
    expect(cost.upToTokens).toContain(RULE);
    expect(cost.upToTokens).not.toMatch(STALE);
    // The placeholders the hint interpolates must survive a rewording.
    for (const placeholder of ['{amount}', '{window}', '{worst}']) {
      expect(cost.upToTokens).toContain(placeholder);
    }
  });

  it('spentBasis.tokens names the same rule, so both surfaces agree', () => {
    expect(cost.spentBasis.tokens).toContain(RULE);
    expect(cost.spentBasis.tokens).not.toMatch(STALE);
    expect(cost.spentBasis.tokens).toContain('a floor, not a bill');
  });
});
