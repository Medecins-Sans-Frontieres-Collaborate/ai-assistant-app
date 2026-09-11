import { IconLeaf } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversationEmissions } from '@/client/hooks/chat/useConversationEmissions';

import {
  EmissionsChipVisibility,
  clampEmissionsChipAutoHideMs,
} from '@/lib/utils/shared/emissions';

import { Conversation } from '@/types/chat';

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

  const rows: ImpactRow[] = [
    ...(showsToday
      ? [{ label: t('emissions.chip.today'), grams: summary.todayG }]
      : []),
    { label: t('emissions.chip.total'), grams: summary.totalG },
    ...(summary.hasEstimated && summary.measuredG > 0
      ? [{ label: t('emissions.chip.measured'), grams: summary.measuredG }]
      : []),
    ...(summary.hasEstimated
      ? [{ label: t('emissions.chip.estimated'), grams: summary.estimatedG }]
      : []),
    ...(summary.lastRequestG != null
      ? [
          {
            label: t('emissions.chip.lastRequest'),
            grams: summary.lastRequestG,
          },
        ]
      : []),
  ];

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
          />
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
