'use client';

import { IconLeaf } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useWorkflowEmissions } from '@/client/hooks/workflows/useWorkflowEmissions';

import { clampEmissionsChipAutoHideMs } from '@/lib/utils/shared/emissions';

import { Conversation } from '@/types/chat';

import {
  ImpactReadout,
  ImpactRow,
  formatGrams,
} from '@/components/Emissions/ImpactReadout';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Maps a ledger phase label to display text. Round suffixes collapse
 * ('review:2' → the "Review rounds" label) so three rounds read as one line
 * with a count, not three near-identical rows. Unknown labels fall through to
 * the raw string rather than showing a missing-key error: orchestrators are
 * free to name new phases, and a new phase must never break the readout.
 */
function actionLabel(
  action: string,
  t: ReturnType<typeof useTranslations>,
): string {
  const base = action.split(':')[0];
  const key = `emissions.workflow.actions.${base}`;
  const translated = t(key);
  return translated === key ? action : translated;
}

interface WorkflowImpactBadgeProps {
  conversation: Conversation | null | undefined;
}

/**
 * The workflow analogue of the chat emissions chip
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §5a–5c).
 *
 * Anchored in the shell header rather than floating over the workspace: the
 * canvases here are dense (a grid, a map, an editor) and a floating bubble
 * would be in the way, while the header is the one surface every workflow
 * shares — and it sits opposite the model selector, which is where the run's
 * cost is actually chosen.
 *
 * Headlines the CURRENT ARTIFACT's spend with the workspace total directly
 * beneath, so crossing an artifact boundary (switching target language,
 * loading a different dataset) never reads as data loss.
 */
export const WorkflowImpactBadge: FC<WorkflowImpactBadgeProps> = ({
  conversation,
}) => {
  const t = useTranslations();
  const { showUsageImpact } = useFlags();
  const summary = useWorkflowEmissions(conversation);
  const visibility = useSettingsStore((s) => s.emissionsChipVisibility);
  const autoHideMs = useSettingsStore((s) => s.emissionsChipAutoHideMs);
  const [isOpen, setIsOpen] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [recentlyUpdated, setRecentlyUpdated] = useState(false);
  const [delta, setDelta] = useState<number | null>(null);
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

  // Render-phase reveal, as in the chat chip: React re-runs the render before
  // committing, so the badge never paints faded for a frame first. The delta
  // is what a finished run adds — the one moment the number is news.
  const totalG = summary?.totalG ?? 0;
  const [seen, setSeen] = useState<{
    totalG: number;
    visibility: string;
  } | null>(null);
  if (
    seen === null ||
    seen.totalG !== totalG ||
    seen.visibility !== visibility
  ) {
    // A first sighting is not a delta: arriving at a workspace that already
    // has a figure should surface it once, not claim a run just happened.
    if (seen !== null && totalG > seen.totalG) setDelta(totalG - seen.totalG);
    setSeen({ totalG, visibility });
    if (totalG > 0) setRecentlyUpdated(true);
  }

  useEffect(() => {
    if (!recentlyUpdated) return;
    const timer = setTimeout(() => {
      setRecentlyUpdated(false);
      setDelta(null);
    }, clampEmissionsChipAutoHideMs(autoHideMs));
    return () => clearTimeout(timer);
  }, [recentlyUpdated, autoHideMs, totalG]);

  // Same fail-open gate as the chat chip: `undefined` (LD unconfigured) shows
  // it; only an explicit `false` hides it.
  if (showUsageImpact === false) return null;
  if (visibility === 'hidden') return null;
  if (!summary || summary.totalG <= 0) return null;

  const isVisible =
    visibility !== 'auto' || recentlyUpdated || isInteracting || isOpen;

  // The artifact is the headline where it is a thing of its own; where the
  // workspace IS the artifact, showing the same number twice would say nothing.
  const headlineG = summary.artifactIsWorkspace
    ? summary.totalG
    : summary.artifactG;
  const collapsedLabel = formatGrams(headlineG);

  const artifactRowLabel =
    summary.artifactLabel ?? t('emissions.workflow.currentArtifact');

  const rows: ImpactRow[] = [
    ...(summary.lastRun
      ? [
          {
            label: t('emissions.workflow.lastRun'),
            grams: summary.lastRun.gCO2e,
            detail: t('emissions.workflow.lastRunDetail', {
              action: actionLabel(summary.lastRun.action, t),
              calls: String(summary.lastRun.calls),
            }),
          },
        ]
      : []),
    ...(summary.artifactIsWorkspace
      ? []
      : [{ label: artifactRowLabel, grams: summary.artifactG }]),
    { label: t('emissions.workflow.workspace'), grams: summary.totalG },
    ...(summary.todayRuns > 0
      ? [{ label: t('emissions.workflow.today'), grams: summary.todayG }]
      : []),
    ...(summary.railG > 0
      ? [
          {
            label: t('emissions.workflow.railChat'),
            grams: summary.railG,
            muted: true,
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
      onFocus={() => setIsInteracting(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsInteracting(false);
          setIsOpen(false);
        }
      }}
      className={`relative transition-opacity duration-200 ease-in-out motion-reduce:transition-none ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {isOpen && (
        <div className="absolute end-0 top-full mt-2 w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-lg dark:border-gray-700 dark:bg-surface-dark z-[10000]">
          <ImpactReadout
            title={t('emissions.workflow.title')}
            rows={rows}
            equivalentsFrom={summary.totalG}
            disclaimerKey="emissions.workflow.disclaimer"
          >
            {summary.byAction.length > 1 && (
              <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
                <p className="mb-1 font-medium text-gray-700 dark:text-gray-300">
                  {t('emissions.workflow.byAction')}
                </p>
                <div className="space-y-0.5">
                  {summary.byAction.map((row) => (
                    <div
                      key={row.action}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="text-gray-600 dark:text-gray-400">
                        {actionLabel(row.action, t)}
                      </span>
                      <span className="text-gray-900 dark:text-gray-100 shrink-0">
                        {t('emissions.chip.label', {
                          grams: formatGrams(row.gCO2e),
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ImpactReadout>
        </div>
      )}
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label={t('emissions.workflow.ariaLabel', {
          grams: collapsedLabel,
        })}
        className={`flex h-8 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-gray-300 dark:hover:bg-surface-dark-elevated ${
          isVisible ? '' : 'pointer-events-none'
        }`}
      >
        <IconLeaf size={16} aria-hidden="true" />
        <span className="hidden sm:inline">
          {t('emissions.chip.label', { grams: collapsedLabel })}
        </span>
        {delta != null && delta > 0 && (
          <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
            {t('emissions.workflow.delta', { grams: formatGrams(delta) })}
          </span>
        )}
      </button>
    </div>
  );
};
