import { IconLeaf } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversationEmissions } from '@/client/hooks/chat/useConversationEmissions';

import {
  ASSUMPTIONS_VERSION,
  EMISSIONS_CHIP_VISIBILITY_OPTIONS,
  EmissionsChipVisibility,
  activityDurationParts,
  clampEmissionsChipAutoHideMs,
  estimateActivityEquivalents,
} from '@/lib/utils/shared/emissions';

import { Conversation } from '@/types/chat';

import { useSettingsStore } from '@/client/stores/settingsStore';

/** <1 g shows decimals ("0.42"); larger values round to whole grams. */
const formatGrams = (grams: number): string =>
  grams < 1
    ? grams.toFixed(2)
    : grams < 10
      ? grams.toFixed(1)
      : `${Math.round(grams)}`;

interface EmissionsChipProps {
  conversation: Conversation | null | undefined;
}

/**
 * Floating chip anchored bottom-right of the chat column showing the current
 * conversation's cumulative estimated CO2e. Hover/tap opens a breakdown
 * popover whose disclaimer states these are request-based estimates from
 * averages and assumptions — never measurements. Icon-only on mobile.
 */
export const EmissionsChip: FC<EmissionsChipProps> = ({ conversation }) => {
  const t = useTranslations();
  const { showUsageImpact } = useFlags();
  const summary = useConversationEmissions(conversation);
  const visibility = useSettingsStore((s) => s.emissionsChipVisibility);
  const autoHideMs = useSettingsStore((s) => s.emissionsChipAutoHideMs);
  const setVisibility = useSettingsStore((s) => s.setEmissionsChipVisibility);
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
  const collapsedLabel = formatGrams(
    showsToday ? summary.todayG : summary.totalG,
  );

  const row = (label: string, grams: number) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100 shrink-0">
        {t('emissions.chip.label', { grams: formatGrams(grams) })}
      </span>
    </div>
  );

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
          <p className="mb-2 font-semibold text-gray-900 dark:text-gray-100">
            {t('emissions.chip.title')}
          </p>
          <div className="space-y-1">
            {showsToday && row(t('emissions.chip.today'), summary.todayG)}
            {row(t('emissions.chip.total'), summary.totalG)}
            {summary.hasEstimated &&
              summary.measuredG > 0 &&
              row(t('emissions.chip.measured'), summary.measuredG)}
            {summary.hasEstimated &&
              row(t('emissions.chip.estimated'), summary.estimatedG)}
            {summary.lastRequestG != null &&
              row(t('emissions.chip.lastRequest'), summary.lastRequestG)}
          </div>
          <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
            <p className="mb-1 font-medium text-gray-700 dark:text-gray-300">
              {t('emissions.equivalents.title')}
            </p>
            <div className="space-y-0.5">
              {estimateActivityEquivalents(summary.totalG).map((equivalent) => {
                const { unit, value } = activityDurationParts(
                  equivalent.seconds,
                );
                return (
                  <div
                    key={equivalent.key}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-gray-600 dark:text-gray-400">
                      {t(`emissions.activities.${equivalent.key}`)}
                    </span>
                    <span className="text-gray-900 dark:text-gray-100 shrink-0">
                      {t(`emissions.duration.${unit}`, { value })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <p className="mt-2 border-t border-gray-200 pt-2 text-[10px] leading-snug text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {t('emissions.chip.disclaimer', { version: ASSUMPTIONS_VERSION })}
          </p>
          {/* Mode switcher — the chip's own settings are otherwise three
              clicks away, and "Hide" needs its undo stated in place. */}
          <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
            <div
              role="group"
              aria-label={t('emissions.chip.visibilityGroup')}
              className="flex items-center gap-1"
            >
              <span className="me-1 text-[10px] text-gray-500 dark:text-gray-400">
                {t('emissions.chip.visibilityLabel')}
              </span>
              {EMISSIONS_CHIP_VISIBILITY_OPTIONS.map(
                (mode: EmissionsChipVisibility) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setVisibility(mode)}
                    aria-pressed={visibility === mode}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                      visibility === mode
                        ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                        : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                    }`}
                  >
                    {t(`emissions.chip.visibility.${mode}`)}
                  </button>
                ),
              )}
            </div>
            <p className="mt-1 text-[10px] leading-snug text-gray-500 dark:text-gray-400">
              {t('emissions.chip.visibilityHint')}
            </p>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label={t(
          showsToday
            ? 'emissions.chip.ariaLabelToday'
            : 'emissions.chip.ariaLabel',
          { grams: collapsedLabel },
        )}
        className={`flex h-9 items-center gap-1.5 rounded-full bg-gray-300 px-2.5 text-xs font-medium text-gray-800 shadow-md transition-shadow hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-gray-700 dark:text-gray-200 dark:focus:ring-offset-gray-900 ${
          isVisible ? '' : 'pointer-events-none'
        }`}
      >
        <IconLeaf size={16} aria-hidden="true" />
        <span className="hidden md:inline">
          {t('emissions.chip.label', { grams: collapsedLabel })}
        </span>
      </button>
    </div>
  );
};
