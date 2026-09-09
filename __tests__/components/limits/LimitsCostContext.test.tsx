import { render } from '@testing-library/react';
import React from 'react';

import { lookupPricing } from '@/lib/utils/app/limitsPricing';

import { OpenAIModel } from '@/types/openai';

import {
  LIMITS_COST_OFF,
  LimitsCostProvider,
  LimitsCostValue,
  useLimitsCost,
} from '@/components/Limits/LimitsCostContext';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract (docs/LIMITS_COST_INSIGHTS_DESIGN.md §1, "hidden means nothing
 * runs"): the context defaults to the OFF constant, so a row rendered
 * without a provider — every pre-existing limits test — sees no cost
 * feature at all; the provider builds the pricing index ONLY when a flag is
 * explicitly `true` (fail-closed, `=== true`), and the calculator gate
 * requires the insights gate — there is no calculator without the per-row
 * numbers it explains.
 */

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const buildPricingIndexSpy = vi.fn();
vi.mock('@/lib/utils/app/limitsPricing', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/utils/app/limitsPricing')>();
  return {
    ...original,
    buildPricingIndex: (models: readonly OpenAIModel[]) => {
      buildPricingIndexSpy(models);
      return original.buildPricingIndex(models);
    },
  };
});

function model(partial: Partial<OpenAIModel> & { id: string }): OpenAIModel {
  return {
    name: partial.id,
    maxLength: 0,
    tokenLimit: 0,
    isDisabled: false,
    ...partial,
  } as OpenAIModel;
}

const SERVED = model({
  id: 'test-served',
  pricing: { inputPer1M: 1, outputPer1M: 1 },
});

/** What a consumer sees, rendered as JSON so the render stays pure. */
interface Seen {
  isOff: boolean;
  insights: boolean;
  calculator: boolean;
  profile: LimitsCostValue['profile'];
  /** lookupPricing('TEST-SERVED') through the index, or null without one. */
  served: { id: string; servedInRing: boolean } | null;
}

const Probe = () => {
  const value = useLimitsCost();
  const hit = value.pricing
    ? lookupPricing(value.pricing, 'TEST-SERVED')
    : null;
  const seen: Seen = {
    isOff: value === LIMITS_COST_OFF,
    insights: value.insights,
    calculator: value.calculator,
    profile: value.profile,
    served: hit ? { id: hit.id, servedInRing: hit.servedInRing } : null,
  };
  return <pre data-testid="probe">{JSON.stringify(seen)}</pre>;
};

function renderProbe(withProvider: boolean): Seen {
  const { getByTestId } = render(
    withProvider ? (
      <LimitsCostProvider>
        <Probe />
      </LimitsCostProvider>
    ) : (
      <Probe />
    ),
  );
  return JSON.parse(getByTestId('probe').textContent ?? '') as Seen;
}

const OFF_SEEN: Seen = {
  isOff: true,
  insights: false,
  calculator: false,
  profile: 'typical',
  served: null,
};

describe('LimitsCostContext', () => {
  beforeEach(() => {
    delete mockFlags.limitsCostInsights;
    delete mockFlags.limitsCostCalculator;
    buildPricingIndexSpy.mockClear();
    useSettingsStore.setState({ models: [SERVED] });
  });

  it('is the OFF constant outside any provider, whatever the flags say', () => {
    mockFlags.limitsCostInsights = true;
    mockFlags.limitsCostCalculator = true;
    expect(renderProbe(false)).toEqual(OFF_SEEN);
    expect(buildPricingIndexSpy).not.toHaveBeenCalled();
  });

  it('is the OFF constant when both flags are undefined, and builds no index', () => {
    expect(renderProbe(true)).toEqual(OFF_SEEN);
    expect(buildPricingIndexSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['an explicit false', false],
    ['a truthy non-boolean', 'true'],
    ['a number', 1],
  ])('fails closed on %s', (_label, served) => {
    mockFlags.limitsCostInsights = served;
    mockFlags.limitsCostCalculator = served;
    expect(renderProbe(true)).toEqual(OFF_SEEN);
    expect(buildPricingIndexSpy).not.toHaveBeenCalled();
  });

  it('builds the index from the served model list once insights are on', () => {
    mockFlags.limitsCostInsights = true;
    expect(renderProbe(true)).toEqual({
      isOff: false,
      insights: true,
      calculator: false,
      profile: 'typical',
      served: { id: 'test-served', servedInRing: true },
    });
    expect(buildPricingIndexSpy).toHaveBeenCalledWith([SERVED]);
  });

  it('never enables the calculator without insights', () => {
    mockFlags.limitsCostCalculator = true;
    expect(renderProbe(true)).toEqual(OFF_SEEN);
    expect(buildPricingIndexSpy).not.toHaveBeenCalled();
  });

  it('enables the calculator only when both flags are on', () => {
    mockFlags.limitsCostInsights = true;
    mockFlags.limitsCostCalculator = true;
    expect(renderProbe(true)).toMatchObject({
      isOff: false,
      insights: true,
      calculator: true,
      served: { id: 'test-served' },
    });
  });

  it('the OFF constant carries no pricing and the typical profile', () => {
    expect(LIMITS_COST_OFF).toEqual({
      insights: false,
      calculator: false,
      pricing: null,
      profile: 'typical',
    });
  });
});
