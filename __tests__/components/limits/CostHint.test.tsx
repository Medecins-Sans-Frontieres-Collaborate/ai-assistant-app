import { render, screen } from '@testing-library/react';
import React from 'react';

import { LimitEntry } from '@/lib/services/limits/types';

import { COST_ASSUMPTIONS_VERSION } from '@/lib/utils/shared/costEstimator';

import { OpenAIModel, PRICING_AS_OF } from '@/types/openai';

import { LimitRow } from '@/components/Limits/LimitRow';
import { LimitsCostProvider } from '@/components/Limits/LimitsCostContext';
import { ScopedLimitRows } from '@/components/Limits/ScopedLimitRows';
import { EntryDraft } from '@/components/Limits/types';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { getLimitDefinition } from '@/config/limits';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract (docs/LIMITS_COST_INSIGHTS_DESIGN.md §4a): a per-row cost
 * annotation appears beside the value control ONLY when `limitsCostInsights`
 * is on, the draft value is a positive number, and pricing resolves —
 *
 *   model.requests @ model   → "≈ $c per typical request · up to ≈ $c×N / day"
 *   model.requests @ family  → "≈ $min–$max per request · up to ≈ $max×N / day"
 *   model.requests / chat.messagesPerDay (unqualified)
 *                            → "up to ≈ $X / day at the priciest ALLOWED model"
 *   chat.tokensPerDay/Month  → the HIGHEST blended $/token among allowed
 *                              models + the output-rate worst case
 *   model.allowed, feature keys, booleans, blocked (0/false), unset, unlimited
 *                            → nothing
 *   a qualifier with no price → "no price data", never $0.
 *
 * The allowed set consults the row's own draft, then `globalDefaults`
 * (draft wins); scoped mode appends "as far as this override can see".
 * Every hint carries the disclosure twice: as a hover `title` and as
 * visually-hidden text it points at with `aria-describedby`, so it is
 * reachable without a mouse. Money is rounded only at display
 * (formatUsdParts) — the fixtures below are chosen so the expected strings
 * are exact.
 */

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

/** Echoes the key and, when values are passed, `key(k=v,k=v)` so numbers are visible. */
vi.mock('next-intl', () => ({
  useTranslations:
    () => (key: string, params?: Record<string, string | number>) =>
      params
        ? `${key}(${Object.entries(params)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')})`
        : key,
  useLocale: () => 'en',
}));

function model(partial: Partial<OpenAIModel> & { id: string }): OpenAIModel {
  return {
    name: partial.id,
    maxLength: 0,
    tokenLimit: 0,
    isDisabled: false,
    ...partial,
  } as OpenAIModel;
}

// Typical request = 1,000 prompt + 500 completion tokens (emissions.json).
/** $0.0015 per typical request — rounds to "< $0.01". */
const CHEAP = model({
  id: 'Test-Cheap',
  series: 'testfam',
  pricing: { inputPer1M: 1, outputPer1M: 1 },
});
/** $0.02 per typical request. */
const DEAR = model({
  id: 'test-dear',
  series: 'testfam',
  pricing: { inputPer1M: 10, outputPer1M: 20 },
});
/** $0.20 per typical request; blended $/token 0.2/1500; output rate 200/1M. */
const OTHER = model({
  id: 'test-other',
  series: 'otherfam',
  pricing: { inputPer1M: 100, outputPer1M: 200 },
});
const UNPRICED = model({ id: 'test-unpriced', series: 'nofam' });
/**
 * A dedicated reasoner: $0.25 per typical request (dearer than OTHER's
 * $0.20) but, with the ×3 reasoner output multiplier in the counted-token
 * denominator (1,000 + 500×3 = 2,500 tokens), a LOWER blended rate —
 * 0.25/2,500 = $0.0001 per token versus OTHER's 0.2/1,500 ≈ $0.000133.
 */
const REASONER = model({
  id: 'test-reasoner',
  series: 'reasonfam',
  modelType: 'reasoning',
  pricing: { inputPer1M: 100, outputPer1M: 100 },
});

const def = (key: string) => {
  const found = getLimitDefinition(key);
  if (!found) throw new Error(`unknown limit key ${key}`);
  return found;
};

const HINT = 'limits-cost-hint';

function renderRow(
  key: string,
  draft: EntryDraft,
  options: {
    provider?: boolean;
    globalDefaults?: LimitEntry[];
    costScopedView?: boolean;
    dimmed?: boolean;
  } = {},
) {
  const { provider = true, ...props } = options;
  const row = (
    <LimitRow def={def(key)} draft={draft} onChange={vi.fn()} {...props} />
  );
  render(provider ? <LimitsCostProvider>{row}</LimitsCostProvider> : row);
}

function renderScoped(key: string, draft: EntryDraft) {
  render(
    <LimitsCostProvider>
      <ScopedLimitRows def={def(key)} draft={draft} onChange={vi.fn()} />
    </LimitsCostProvider>,
  );
}

/** Only the direct row's hint (a perModel LimitRow also nests ScopedLimitRows). */
const hints = () => screen.queryAllByTestId(HINT).map((el) => el.textContent);

describe('CostHint', () => {
  beforeEach(() => {
    delete mockFlags.limitsCostInsights;
    delete mockFlags.limitsCostCalculator;
    useSettingsStore.setState({ models: [CHEAP, DEAR, OTHER, UNPRICED] });
  });

  describe('OFF path', () => {
    it('renders nothing when the flag is undefined', () => {
      renderRow('chat.messagesPerDay', { 'chat.messagesPerDay': 10 });
      expect(hints()).toEqual([]);
      expect(screen.queryByText(/cost\./)).not.toBeInTheDocument();
    });

    it('renders nothing without a provider even when the flag is on', () => {
      mockFlags.limitsCostInsights = true;
      renderRow(
        'chat.messagesPerDay',
        { 'chat.messagesPerDay': 10 },
        { provider: false },
      );
      expect(hints()).toEqual([]);
    });
  });

  describe('unqualified rows (insights on)', () => {
    beforeEach(() => {
      mockFlags.limitsCostInsights = true;
    });

    it('bounds chat.messagesPerDay at the priciest allowed model', () => {
      renderRow('chat.messagesPerDay', { 'chat.messagesPerDay': 10 });
      expect(hints()).toEqual([
        'cost.upToPriciest(amount=$2.00,window=window.day,perRequest=$0.20)',
      ]);
    });

    it('bounds the unqualified model.requests row the same way', () => {
      renderRow('model.requests', { 'model.requests': 150 });
      expect(hints()).toEqual([
        'cost.upToPriciest(amount=$30.00,window=window.day,perRequest=$0.20)',
      ]);
    });

    it('drops models whose model.allowed cell is false in the draft (family level)', () => {
      renderRow('model.requests', {
        'model.requests': 150,
        'model.allowed@family:otherfam': false,
      });
      expect(hints()).toEqual([
        'cost.upToPriciest(amount=$3.00,window=window.day,perRequest=$0.02)',
      ]);
    });

    it('consults globalDefaults after the draft, and the draft wins', () => {
      const blockOther: LimitEntry[] = [
        {
          limitKey: 'model.allowed',
          modelId: 'TEST-OTHER',
          value: false,
          ceiling: false,
        },
      ];
      renderRow(
        'chat.messagesPerDay',
        { 'chat.messagesPerDay': 100 },
        { globalDefaults: blockOther },
      );
      expect(hints()).toEqual([
        'cost.upToPriciest(amount=$2.00,window=window.day,perRequest=$0.02)',
      ]);
    });

    it('lets the draft re-allow a model the defaults block', () => {
      const blockOther: LimitEntry[] = [
        {
          limitKey: 'model.allowed',
          modelId: 'test-other',
          value: false,
          ceiling: false,
        },
      ];
      renderRow(
        'chat.messagesPerDay',
        { 'chat.messagesPerDay': 100, 'model.allowed@model:test-other': true },
        { globalDefaults: blockOther },
      );
      expect(hints()).toEqual([
        'cost.upToPriciest(amount=$20.00,window=window.day,perRequest=$0.20)',
      ]);
    });

    it('prices token caps at the blended rate with the output-rate worst case', () => {
      // OTHER: 0.2 / 1,500 counted tokens per typical request; output 200/1M.
      renderRow('chat.tokensPerDay', { 'chat.tokensPerDay': 1_000_000 });
      expect(hints()).toEqual([
        'cost.upToTokens(amount=$133.33,window=window.day,worst=$200.00)',
      ]);
    });

    it('prices token caps at the HIGHEST blended rate among allowed models, not the dearest-per-request one', () => {
      // Pins the code to the `cost.upToTokens` wording ("highest blended rate
      // among allowed models"): REASONER is the priciest per request, OTHER
      // has the higher $/token, so 1M tokens bound at OTHER's $133.33 — not
      // REASONER's $100. Worst case stays OTHER's output rate ($200).
      useSettingsStore.setState({ models: [OTHER, REASONER] });
      renderRow('chat.tokensPerDay', { 'chat.tokensPerDay': 1_000_000 });
      expect(hints()).toEqual([
        'cost.upToTokens(amount=$133.33,window=window.day,worst=$200.00)',
      ]);
      // Sanity: REASONER really is the dearest per request in this set.
      renderRow('chat.messagesPerDay', { 'chat.messagesPerDay': 4 });
      expect(hints()).toContain(
        'cost.upToPriciest(amount=$1.00,window=window.day,perRequest=$0.25)',
      );
    });

    it('uses the month window for chat.tokensPerMonth', () => {
      renderRow('chat.tokensPerMonth', { 'chat.tokensPerMonth': 1_000_000 });
      expect(hints()[0]).toMatch(/window=window\.month/);
    });

    it('says "no price data" — never $0 — when nothing priced is allowed', () => {
      renderRow('chat.messagesPerDay', {
        'chat.messagesPerDay': 10,
        'model.allowed': false,
      });
      expect(hints()).toEqual(['cost.noPriceData']);
    });

    it('says "no price data" before the served model list is populated', () => {
      useSettingsStore.setState({ models: [] });
      renderRow('chat.messagesPerDay', { 'chat.messagesPerDay': 10 });
      expect(hints()).toEqual(['cost.noPriceData']);
      expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    });

    it('appends the visibility note in scoped mode', () => {
      renderRow(
        'chat.messagesPerDay',
        { 'chat.messagesPerDay': 10 },
        { costScopedView: true },
      );
      expect(hints()[0]).toMatch(
        /^cost\.upToPriciest\(.*\) · cost\.scopedVisibility$/,
      );
    });

    it('carries the disclosure (as-of date + assumptions version) as its title', () => {
      renderRow('chat.messagesPerDay', { 'chat.messagesPerDay': 10 });
      expect(screen.getByTestId(HINT)).toHaveAttribute(
        'title',
        `cost.disclosure(asOf=${PRICING_AS_OF},version=${COST_ASSUMPTIONS_VERSION})`,
      );
    });

    it('exposes the disclosure to assistive tech: visually-hidden text the hint points at with aria-describedby', () => {
      renderRow('chat.messagesPerDay', { 'chat.messagesPerDay': 10 });
      const hint = screen.getByTestId(HINT);
      const describedBy = hint.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const disclosure = document.getElementById(describedBy as string);
      expect(disclosure).not.toBeNull();
      expect(disclosure).toHaveTextContent(
        `cost.disclosure(asOf=${PRICING_AS_OF},version=${COST_ASSUMPTIONS_VERSION})`,
      );
      expect(disclosure).toHaveClass('sr-only');
      // The hint's own text stays the priced line — the disclosure is a
      // sibling, so nothing an admin sees inline changes.
      expect(hint).toHaveTextContent(/^cost\.upToPriciest\(/);
      expect(hint).not.toHaveTextContent('cost.disclosure');
    });

    it('gives every hint its own disclosure target (ids stay unique across rows)', () => {
      renderScoped('model.requests', {
        'model.requests@model:test-dear': 50,
        'model.requests@family:testfam': 100,
      });
      const ids = screen
        .getAllByTestId(HINT)
        .map((el) => el.getAttribute('aria-describedby'));
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) {
        expect(document.getElementById(id as string)).toHaveClass('sr-only');
      }
    });
  });

  describe('rows that never price (insights on)', () => {
    beforeEach(() => {
      mockFlags.limitsCostInsights = true;
    });

    it.each([
      ['a feature counter', 'feature.tts.charactersPerDay', 5000],
      ['a boolean gate', 'feature.webSearch.enabled', true],
      ['a per-request ceiling', 'feature.upload.megabytesPerFile', 20],
      ['model.allowed', 'model.allowed', true],
      ['a blocked counter', 'chat.messagesPerDay', 0],
      ['a blocked model.requests', 'model.requests', 0],
      ['an unlimited counter', 'chat.messagesPerDay', null],
    ] as const)('renders nothing for %s', (_label, key, value) => {
      renderRow(key, { [key]: value });
      expect(hints()).toEqual([]);
    });

    it('renders nothing for an unset row', () => {
      renderRow('chat.messagesPerDay', {});
      expect(hints()).toEqual([]);
    });

    it('renders nothing on a dimmed row (gate off) — a PRICEABLE key, so the guard is what is tested', () => {
      // LimitRow's `!dimmed` guard is defensive (no gated group holds a key
      // that prices today), so this is its ONLY direct coverage: the same
      // draft hints when not dimmed and must not when dimmed.
      const draft: EntryDraft = { 'chat.messagesPerDay': 10 };
      const { unmount } = render(
        <LimitsCostProvider>
          <LimitRow
            def={def('chat.messagesPerDay')}
            draft={draft}
            onChange={vi.fn()}
          />
        </LimitsCostProvider>,
      );
      expect(hints()).toHaveLength(1);
      unmount();
      renderRow('chat.messagesPerDay', draft, { dimmed: true });
      expect(hints()).toEqual([]);
    });
  });

  describe('qualified model.requests cells (insights on)', () => {
    beforeEach(() => {
      mockFlags.limitsCostInsights = true;
    });

    it('prices a model cell by that model, case-insensitively', () => {
      renderScoped('model.requests', { 'model.requests@model:TEST-DEAR': 50 });
      expect(hints()).toEqual([
        'cost.perRequest(amount=$0.02) · cost.upTo(amount=$1.00,window=window.day)',
      ]);
    });

    it('prices a family cell as a min–max range bounded by the priciest member', () => {
      renderScoped('model.requests', { 'model.requests@family:testfam': 100 });
      expect(hints()).toEqual([
        'cost.perRequestRange(min=cost.lessThan(amount=$0.01),max=$0.02) · cost.upTo(amount=$2.00,window=window.day)',
      ]);
    });

    it('prices a stored id this ring does not serve from the static registry', () => {
      // gpt-5.6-terra is in config/models.json ($0.008 typical) but not served here.
      renderScoped('model.requests', {
        'model.requests@model:gpt-5.6-terra': 100,
      });
      expect(hints()).toEqual([
        'cost.perRequest(amount=$0.01) · cost.upTo(amount=$0.80,window=window.day)',
      ]);
    });

    it.each([
      ['an unpriced model', 'model.requests@model:test-unpriced'],
      ['a byom model', 'model.requests@model:byom-abc-gpt-5.6-terra'],
      ['a local model', 'model.requests@model:local-llama'],
      ['an agent', 'model.requests@model:org-comms'],
      ['an unknown id', 'model.requests@model:nope-9000'],
      ['a family with no priced member', 'model.requests@family:nofam'],
    ])('says "no price data" for %s', (_label, key) => {
      renderScoped('model.requests', { [key]: 10 });
      expect(hints()).toEqual(['cost.noPriceData']);
      expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    });

    it('renders nothing for model.allowed cells and blocked model cells', () => {
      renderScoped('model.allowed', {
        'model.allowed@model:test-dear': false,
        'model.allowed@family:testfam': true,
      });
      expect(hints()).toEqual([]);
      renderScoped('model.requests', { 'model.requests@model:test-dear': 0 });
      expect(hints()).toEqual([]);
    });

    it('renders nothing for any qualified cell when the flag is off', () => {
      delete mockFlags.limitsCostInsights;
      renderScoped('model.requests', {
        'model.requests@model:test-dear': 50,
        'model.requests@family:testfam': 100,
      });
      expect(hints()).toEqual([]);
    });
  });
});
