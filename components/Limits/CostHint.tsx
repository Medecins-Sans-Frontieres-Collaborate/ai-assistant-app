'use client';

import { FC, useId } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import type { LimitEntry } from '@/lib/services/limits/types';

import {
  PricingIndex,
  PricingIndexEntry,
  allowedModels,
  familyRange,
  lookupPricing,
  modelRequestCost,
} from '@/lib/utils/app/limitsPricing';
import {
  COST_ASSUMPTIONS_VERSION,
  RequestProfile,
  blendedPerTokenUsd,
  formatUsdParts,
  outputPerTokenUsd,
} from '@/lib/utils/shared/costEstimator';

import { PRICING_AS_OF } from '@/types/openai';

import { ADMIN_MUTED } from '@/components/Admin/adminClasses';
import type { LimitValueState } from '@/components/Limits/LimitValueInput';
import { useLimitsCost } from '@/components/Limits/LimitsCostContext';
import type { LimitsTranslate } from '@/components/Limits/summaries';
import type { EntryDraft } from '@/components/Limits/types';

import { LimitDefinition } from '@/config/limits';

/**
 * Money for display, rounded ONLY here: "< $0.01" below half a cent, else
 * the locale's currency string. A `zero` result is rendered as the
 * translated "$0.00" token — the caller is responsible for never asking for
 * an unpriced model (the helpers above return `null`, not 0, for those).
 */
export function usdLabel(value: number, locale: string, t: LimitsTranslate) {
  const parts = formatUsdParts(value, locale);
  if (parts.kind === 'zero') return t('cost.zeroAmount');
  if (parts.kind === 'lessThan')
    return t('cost.lessThan', { amount: parts.text });
  return parts.text;
}

/**
 * The disclosure every cost surface carries (design §4): list prices, the
 * as-of date, the assumption-set version, and what the figure excludes.
 * Insight surfaces always price at Global Standard (×1); the deployment
 * multiplier is an estimator input only.
 */
export function costDisclosure(t: LimitsTranslate): string {
  return t('cost.disclosure', {
    asOf: PRICING_AS_OF,
    version: COST_ASSUMPTIONS_VERSION,
  });
}

/** The keys a per-row annotation exists for (design §4a); everything else renders nothing. */
const COST_HINT_KEYS: ReadonlySet<string> = new Set([
  'model.requests',
  'chat.messagesPerDay',
  'chat.tokensPerDay',
  'chat.tokensPerMonth',
]);

export interface CostHintProps {
  def: LimitDefinition;
  /** The draft value of THIS cell — only a positive number gets a hint. */
  value: LimitValueState | undefined;
  modelId?: string;
  series?: string;
  /**
   * The layer whose `model.allowed` cells define the allowed set for an
   * unqualified row (the defaults draft, or the override's own draft).
   */
  draft: EntryDraft;
  /** Second layer for the allowed set: the global defaults (OverrideEditor). */
  globalDefaults?: readonly LimitEntry[];
  /**
   * Scoped mode: the global defaults are never sent, so the allowed set is
   * only "as far as this override can see" — said on the unqualified rows.
   */
  scopedView?: boolean;
}

/**
 * Per-row cost annotation beside a limit's value control (design §4a).
 * Renders nothing unless `limitsCostInsights` is on, the key is one that
 * prices, and the draft value is a positive number — so blocked (0/false)
 * rows, booleans, feature counters, unset rows and `model.allowed` never
 * carry cost copy. A qualifier with no price says so ("no price data") and
 * never shows $0.
 *
 * The disclosure (design §4) travels with every hint: as a hover `title`
 * for mouse users AND as visually-hidden text the hint points at with
 * `aria-describedby`, so keyboard, touch and screen-reader admins get the
 * as-of / upper-bound caveat too — a `<p>` cannot take focus and `title` is
 * not reliably announced on static text. The hidden copy is a sibling, not a
 * child, so the hint's own text stays exactly the priced line.
 *
 * Split in two so the hooks the priced body needs (`useLocale`) are only
 * ever called on the ON path: a flags-off deployment mounts nothing here.
 */
export const CostHint: FC<CostHintProps> = (props) => {
  const { insights, pricing } = useLimitsCost();
  if (!insights || !pricing) return null;
  if (!COST_HINT_KEYS.has(props.def.key)) return null;
  if (
    typeof props.value !== 'number' ||
    !Number.isFinite(props.value) ||
    props.value <= 0
  ) {
    return null;
  }
  return <CostHintBody {...props} value={props.value} pricing={pricing} />;
};

interface CostHintBodyProps extends CostHintProps {
  value: number;
  pricing: PricingIndex;
}

type HintCopy = { kind: 'lines'; lines: string[] } | { kind: 'no-price' };

/** The dearest per-request total among `entries`, or undefined when empty. */
function priciestOf(
  entries: readonly PricingIndexEntry[],
  profile: RequestProfile,
): { entry: PricingIndexEntry; total: number } | undefined {
  let best: { entry: PricingIndexEntry; total: number } | undefined;
  for (const entry of entries) {
    const total = modelRequestCost(entry, profile).total;
    if (!best || total > best.total) best = { entry, total };
  }
  return best;
}

const CostHintBody: FC<CostHintBodyProps> = ({
  def,
  value,
  modelId,
  series,
  draft,
  globalDefaults,
  scopedView = false,
  pricing,
}) => {
  const t = useTranslations('limits');
  const locale = useLocale();
  const { profile } = useLimitsCost();
  const disclosureId = useId();
  const disclosure = costDisclosure(t);
  const usd = (amount: number) => usdLabel(amount, locale, t);
  const window = t(`window.${def.window}` as never);

  const copy = ((): HintCopy => {
    // Qualified model.requests cells price the qualifier itself.
    if (def.key === 'model.requests' && modelId) {
      const entry = lookupPricing(pricing, modelId);
      if (!entry) return { kind: 'no-price' };
      const perRequest = modelRequestCost(entry, profile).total;
      return {
        kind: 'lines',
        lines: [
          t('cost.perRequest', { amount: usd(perRequest) }),
          t('cost.upTo', { amount: usd(perRequest * value), window }),
        ],
      };
    }
    if (def.key === 'model.requests' && series) {
      const range = familyRange(series, pricing, profile);
      if (!range) return { kind: 'no-price' };
      return {
        kind: 'lines',
        lines: [
          t('cost.perRequestRange', {
            min: usd(range.min),
            max: usd(range.max),
          }),
          t('cost.upTo', { amount: usd(range.max * value), window }),
        ],
      };
    }

    // Unqualified rows bound via the priciest model the allowed set leaves.
    const allowed = allowedModels(pricing, draft, globalDefaults);
    const priciest = priciestOf(allowed, profile);
    if (!priciest) return { kind: 'no-price' };
    const lines: string[] = [];
    if (def.unit === 'tokens') {
      // Token caps count total tokens: the typical figure uses the HIGHEST
      // blended $/token among allowed models — not the model that is dearest
      // per request, which (via the reasoner output multiplier) can carry a
      // lower $/counted-token; `cost.upToTokens` says exactly that. The worst
      // case bills every token at the highest output rate (Global Standard,
      // ×1).
      let blended = 0;
      let worst = 0;
      for (const entry of allowed) {
        blended = Math.max(
          blended,
          blendedPerTokenUsd(modelRequestCost(entry, profile)),
        );
        worst = Math.max(worst, outputPerTokenUsd(entry.pricing));
      }
      lines.push(
        t('cost.upToTokens', {
          amount: usd(value * blended),
          window,
          worst: usd(value * worst),
        }),
      );
    } else {
      lines.push(
        t('cost.upToPriciest', {
          amount: usd(priciest.total * value),
          window,
          perRequest: usd(priciest.total),
        }),
      );
    }
    if (scopedView) lines.push(t('cost.scopedVisibility'));
    return { kind: 'lines', lines };
  })();

  return (
    <>
      <p
        className={ADMIN_MUTED}
        title={disclosure}
        aria-describedby={disclosureId}
        data-testid="limits-cost-hint"
      >
        {copy.kind === 'no-price'
          ? t('cost.noPriceData')
          : copy.lines.join(' · ')}
      </p>
      <span
        id={disclosureId}
        className="sr-only"
        data-testid="limits-cost-disclosure"
      >
        {disclosure}
      </span>
    </>
  );
};
