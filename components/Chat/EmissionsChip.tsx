import { IconCoin, IconLeaf } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useEffect, useRef, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useConversationCost } from '@/client/hooks/chat/useConversationCost';
import { useConversationEmissions } from '@/client/hooks/chat/useConversationEmissions';

import { formatUsdLabel } from '@/lib/utils/shared/chat/requestCost';
import {
  EmissionsChipVisibility,
  clampEmissionsChipAutoHideMs,
} from '@/lib/utils/shared/emissions';

import { Conversation } from '@/types/chat';

import { CostFootnote } from '@/components/Emissions/CostFootnote';
import {
  ImpactReadout,
  ImpactRow,
  formatGrams,
} from '@/components/Emissions/ImpactReadout';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface EmissionsChipProps {
  conversation: Conversation | null | undefined;
}

/**
 * Floating chip anchored bottom-right of the chat column showing the current
 * conversation's cumulative estimated CO2e — and, in the same popover, its
 * estimated list-price cost for the same requests (docs/CHAT_COST_CHIP.md).
 * Hover/tap opens a breakdown whose disclaimers state these are
 * request-based estimates from averages, list prices and assumptions — never
 * measurements or bills. Icon-only on mobile.
 *
 * One chip, not two: cost rides as a second column in the impact rows and the
 * collapsed label reads emissions unless the user picks otherwise in
 * Settings › Usage & Impact, so the addition costs nothing in noise.
 */
export const EmissionsChip: FC<EmissionsChipProps> = ({ conversation }) => {
  const t = useTranslations();
  const locale = useLocale();
  const { showUsageImpact, showUsageCost } = useFlags();
  const summary = useConversationEmissions(conversation);
  const cost = useConversationCost(conversation);
  const visibility = useSettingsStore((s) => s.emissionsChipVisibility);
  const labelMode = useSettingsStore((s) => s.emissionsChipLabelMode);
  const autoHideMs = useSettingsStore((s) => s.emissionsChipAutoHideMs);
  const [isOpen, setIsOpen] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [recentlyUpdated, setRecentlyUpdated] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on tap/click outside (mobile has no hover-leave).
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Auto mode: reveal on every change to the estimate, then fade after the
  // configured delay. While a response streams, the back-calculated portion
  // recomputes on each token, so this re-arms continuously and the chip stays
  // up for the whole response — fading only once the figure settles.
  //
  // The reveal is a render-phase adjustment rather than an effect: React
  // re-runs this render before committing, so the chip never paints faded for
  // a frame first. See "You Might Not Need an Effect".
  const totalG = summary?.totalG ?? 0;
  // Starts null so the first render with a real estimate counts as an update:
  // arriving at a conversation that already has a figure should surface it
  // once, not leave the chip invisible until the next response.
  const [seen, setSeen] = useState<{
    totalG: number;
    visibility: EmissionsChipVisibility;
  } | null>(null);
  if (
    seen === null ||
    seen.totalG !== totalG ||
    seen.visibility !== visibility
  ) {
    setSeen({ totalG, visibility });
    // Switching *into* auto also counts, so the chip doesn't vanish the
    // instant the mode is selected in Settings.
    if (visibility === 'auto' && totalG > 0) setRecentlyUpdated(true);
  }

  // Only the fade-out is a timer, and it sets state from the callback rather
  // than the effect body. Re-arms whenever the estimate changes.
  useEffect(() => {
    if (!recentlyUpdated) return;
    const timer = setTimeout(
      () => setRecentlyUpdated(false),
      clampEmissionsChipAutoHideMs(autoHideMs),
    );
    return () => clearTimeout(timer);
  }, [recentlyUpdated, autoHideMs, totalG]);

  // Same fail-open gate as the Usage & Impact settings section: `undefined`
  // (LD unconfigured) shows the chip; only an explicit `false` hides it.
  if (showUsageImpact === false) return null;
  if (visibility === 'hidden') return null;
  if (!summary || summary.totalG <= 0) return null;

  // In `auto`, anything that counts as reaching for the chip keeps it up.
  const isVisible =
    visibility !== 'auto' || recentlyUpdated || isInteracting || isOpen;

  // Adaptive collapsed label: once there's activity today, show today's
  // figure (the actionable number for long-lived conversations, where the
  // lifetime total is a big static value); otherwise the conversation total.
  const showsToday = summary.todayRequests > 0;
  const collapsedGrams = formatGrams(
    showsToday ? summary.todayG : summary.totalG,
  );

  // Same fail-open rule as the impact flag; the cost column also needs a
  // summary (agent conversations have none).
  const costShown = showUsageCost !== false && cost !== null;
  const usd = (value: number) =>
    formatUsdLabel(value, locale, (amount) =>
      t('emissions.chip.cost.lessThan', { amount }),
    );
  // A row's dollar cell is null when none of its requests could be priced.
  const priced = costShown && cost.pricedRequests > 0;
  const usdCell = (value: number, present: boolean): string | null =>
    priced && present ? usd(value) : null;

  const rows: ImpactRow[] = [
    ...(showsToday
      ? [
          {
            label: t('emissions.chip.today'),
            grams: summary.todayG,
            ...(costShown
              ? { usd: usdCell(cost.todayUsd, cost.todayRequests > 0) }
              : {}),
          },
        ]
      : []),
    {
      label: t('emissions.chip.total'),
      grams: summary.totalG,
      ...(costShown ? { usd: usdCell(cost.totalUsd, true) } : {}),
    },
    ...(summary.hasEstimated && summary.measuredG > 0
      ? [
          {
            label: t('emissions.chip.measured'),
            grams: summary.measuredG,
            ...(costShown
              ? { usd: usdCell(cost.measuredUsd, cost.measuredUsd > 0) }
              : {}),
          },
        ]
      : []),
    ...(summary.hasEstimated
      ? [
          {
            label: t('emissions.chip.estimated'),
            grams: summary.estimatedG,
            ...(costShown
              ? { usd: usdCell(cost.estimatedUsd, cost.hasEstimated) }
              : {}),
          },
        ]
      : []),
    ...(summary.lastRequestG != null
      ? [
          {
            label: t('emissions.chip.lastRequest'),
            grams: summary.lastRequestG,
            ...(costShown
              ? {
                  usd: usdCell(
                    cost.lastRequestUsd ?? 0,
                    cost.lastRequestUsd != null,
                  ),
                }
              : {}),
          },
        ]
      : []),
  ];

  // Collapsed label: emissions unless the user asked for cost and there is a
  // priced figure to show — a cost-only chip must never read "$0.00" for a
  // conversation whose model simply has no list price.
  const collapsedUsd = priced
    ? usd(showsToday ? cost.todayUsd : cost.totalUsd)
    : null;
  const effectiveMode = collapsedUsd === null ? 'emissions' : labelMode;
  const collapsedLabel =
    effectiveMode === 'cost'
      ? collapsedUsd
      : effectiveMode === 'both'
        ? t('emissions.chip.labelBoth', {
            grams: collapsedGrams,
            cost: collapsedUsd ?? '',
          })
        : t('emissions.chip.label', { grams: collapsedGrams });
  const ariaLabel =
    t(
      showsToday ? 'emissions.chip.ariaLabelToday' : 'emissions.chip.ariaLabel',
      {
        grams: collapsedGrams,
      },
    ) +
    (collapsedUsd !== null && effectiveMode !== 'emissions'
      ? ` ${t('emissions.chip.costAria', { cost: collapsedUsd })}`
      : '');
  const Icon = effectiveMode === 'cost' ? IconCoin : IconLeaf;

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => {
        setIsInteracting(true);
        setIsOpen(true);
      }}
      onMouseLeave={() => {
        setIsInteracting(false);
        setIsOpen(false);
      }}
      // Focus reveals the chip but deliberately does not open the popover —
      // tabbing past a control should not spring a panel open. Enter/Space on
      // the button still toggles it.
      onFocus={() => setIsInteracting(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsInteracting(false);
          setIsOpen(false);
        }
      }}
      // Pointer events stay on the wrapper even while faded: it is the hover
      // target that brings the chip back ("hover over the location"). Only the
      // button opts out, so a click here reveals rather than opening the
      // popover blind.
      className={`relative transition-opacity duration-200 ease-in-out motion-reduce:transition-none ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {isOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-lg dark:border-gray-700 dark:bg-surface-dark z-[10000]">
          <ImpactReadout
            title={t('emissions.chip.title')}
            rows={rows}
            equivalentsFrom={summary.totalG}
            disclaimerKey="emissions.chip.disclaimer"
          >
            {costShown && <CostFootnote summary={cost} />}
          </ImpactReadout>
        </div>
      )}
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        className={`flex h-9 items-center gap-1.5 rounded-full bg-gray-300 px-2.5 text-xs font-medium text-gray-800 shadow-md transition-shadow hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-gray-700 dark:text-gray-200 dark:focus:ring-offset-gray-900 ${
          isVisible ? '' : 'pointer-events-none'
        }`}
      >
        <Icon size={16} aria-hidden="true" />
        <span className="hidden md:inline">{collapsedLabel}</span>
      </button>
    </div>
  );
};
