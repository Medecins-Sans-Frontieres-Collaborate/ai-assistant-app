import {
  ADMISSION_HEADROOM,
  NATIVE_INTERPRETER_PLANNED_MODEL_CALLS,
  admissibleRequestTokens,
  applyAdmissionCeiling,
  deploymentTokensPerMinute,
  perCallTokensPerMinute,
} from '@/lib/utils/shared/modelThroughput';

import { describe, expect, it } from 'vitest';

// Shaped like prod gpt-6-astra: a 272K window with a 32K output limit.
const astra = { maxLength: 272_000, tokenLimit: 32_000 };

describe('deploymentTokensPerMinute', () => {
  it.each(['Standard', 'GlobalStandard', 'DataZoneStandard', 'globalstandard'])(
    'reads %s capacity as thousands of TPM',
    (sku) => {
      expect(deploymentTokensPerMinute(sku, 250)).toBe(250_000);
    },
  );

  it.each([
    'GlobalProvisionedManaged',
    'DataZoneProvisionedManaged',
    'GlobalBatch',
    'SomethingNew',
  ])('yields no ceiling for non-TPM SKU %s', (sku) => {
    expect(deploymentTokensPerMinute(sku, 250)).toBeUndefined();
  });

  it.each([undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'yields no ceiling for capacity %s',
    (capacity) => {
      expect(
        deploymentTokensPerMinute('GlobalStandard', capacity),
      ).toBeUndefined();
    },
  );

  it('yields no ceiling when the SKU is missing', () => {
    expect(deploymentTokensPerMinute(undefined, 250)).toBeUndefined();
  });
});

describe('applyAdmissionCeiling', () => {
  it('leaves the model untouched when throughput is unknown', () => {
    expect(applyAdmissionCeiling(astra, undefined)).toBe(astra);
    expect(applyAdmissionCeiling(astra, 0)).toBe(astra);
  });

  it('caps the 250K TPM Astra deployment below its catalog window', () => {
    const capped = applyAdmissionCeiling(astra, 250_000);
    expect(capped.maxLength).toBe(225_000);
    expect(capped.maxLength).toBe(admissibleRequestTokens(250_000));
    // The output reservation is small next to the ceiling, so it is kept.
    expect(capped.tokenLimit).toBe(32_000);
    expect(capped.tokensPerMinute).toBe(250_000);
  });

  it('does not mutate its input', () => {
    const input = { ...astra };
    applyAdmissionCeiling(input, 250_000);
    expect(input).toEqual(astra);
  });

  // Boundary bracket: the window that exactly equals the ceiling must pass
  // through, one token over must be capped.
  it('keeps a window exactly at the ceiling and caps one token over', () => {
    const tpm = 300_000;
    const ceiling = admissibleRequestTokens(tpm);
    const atCeiling = applyAdmissionCeiling(
      { maxLength: ceiling, tokenLimit: 32_000 },
      tpm,
    );
    expect(atCeiling.maxLength).toBe(ceiling);
    expect(atCeiling.tokensPerMinute).toBe(tpm);

    const overCeiling = applyAdmissionCeiling(
      { maxLength: ceiling + 1, tokenLimit: 32_000 },
      tpm,
    );
    expect(overCeiling.maxLength).toBe(ceiling);
  });

  it('lifts the cap once capacity covers the full window plus headroom', () => {
    const tpm = Math.ceil(astra.maxLength / ADMISSION_HEADROOM);
    expect(applyAdmissionCeiling(astra, tpm).maxLength).toBe(astra.maxLength);
    expect(applyAdmissionCeiling(astra, 1_000_000).maxLength).toBe(
      astra.maxLength,
    );
  });

  it('shrinks the output reservation only when it would starve the input', () => {
    // 20K TPM -> 18K ceiling; a 16K output limit would leave ~2K for input.
    const tiny = applyAdmissionCeiling(
      { maxLength: 128_000, tokenLimit: 16_000 },
      20_000,
    );
    expect(tiny.maxLength).toBe(18_000);
    expect(tiny.tokenLimit).toBeLessThan(tiny.maxLength / 2);
    expect(tiny.tokenLimit).toBeGreaterThanOrEqual(1_024);
  });

  it('keeps the output reservation just under half the ceiling', () => {
    const ceiling = admissibleRequestTokens(100_000); // 90K
    const kept = applyAdmissionCeiling(
      { maxLength: 128_000, tokenLimit: ceiling / 2 - 1 },
      100_000,
    );
    expect(kept.tokenLimit).toBe(ceiling / 2 - 1);
    const shrunk = applyAdmissionCeiling(
      { maxLength: 128_000, tokenLimit: ceiling / 2 },
      100_000,
    );
    expect(shrunk.tokenLimit).toBeLessThan(ceiling / 2);
  });
});

describe('perCallTokensPerMinute', () => {
  it('splits the deployment limit across the planned calls', () => {
    expect(perCallTokensPerMinute(250_000, 3)).toBe(83_333);
    expect(perCallTokensPerMinute(250_000, 1)).toBe(250_000);
  });

  it('treats fewer than one call as one and passes unknown limits through', () => {
    expect(perCallTokensPerMinute(250_000, 0)).toBe(250_000);
    expect(perCallTokensPerMinute(undefined, 3)).toBeUndefined();
  });

  it('leaves a 1M TPM Astra window untouched on an interpreter turn', () => {
    const perCall = perCallTokensPerMinute(
      1_000_000,
      NATIVE_INTERPRETER_PLANNED_MODEL_CALLS,
    )!;
    expect(admissibleRequestTokens(perCall)).toBeGreaterThanOrEqual(272_000);
  });
});
