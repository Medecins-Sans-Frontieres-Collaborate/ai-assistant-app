'use client';

import { IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-react';
import {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import {
  ANALYSIS_STRIP_HEIGHT,
  clampAnalysisStripHeight,
  countAnalysisNotes,
  hasPaperTrail,
  lastReviewVerdict,
} from '@/lib/utils/shared/translation/runProgress';

import {
  TranslationAnalysis,
  TranslationGlossaryCheck,
  TranslationReviewRound,
} from '@/types/workflow';

import { AnalysisPanel } from './AnalysisPanel';

interface AnalysisStripProps {
  analysis?: TranslationAnalysis;
  rounds: TranslationReviewRound[];
  glossaryCheck?: TranslationGlossaryCheck;
  /** False shows only the one-line header. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Hides the strip for every translation (a user preference). */
  onDismiss: () => void;
  /** Height of the expanded strip, in CSS pixels. */
  height: number;
  /** Called with the new height once a resize finishes. */
  onResize: (height: number) => void;
}

const ICON_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated';
const CHIP_CLASS =
  'rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300';

/**
 * The run's paper trail (analysis, review rounds, glossary check) as a
 * strip under the panes that the user controls: a one-line header that
 * expands, a handle to resize the expanded strip, and a dismiss button.
 *
 * RESIZE DIRECTION CONVENTION: the strip is anchored to the bottom, so its
 * handle is on its top edge and moving the handle UP makes the strip
 * TALLER. Pointer drags and arrow keys both follow that: up grows, down
 * shrinks.
 *
 * While a drag is in progress the height lives in local state; the caller
 * is told once, on release, so a preference is not rewritten per pixel.
 */
export function AnalysisStrip({
  analysis,
  rounds,
  glossaryCheck,
  expanded,
  onToggleExpanded,
  onDismiss,
  height,
  onResize,
}: AnalysisStripProps) {
  const t = useTranslations('workflows');
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragStart = useRef<{ pointerY: number; height: number } | null>(null);

  if (!hasPaperTrail({ analysis, rounds, glossaryCheck })) return null;

  const shownHeight = dragHeight ?? clampAnalysisStripHeight(height);
  const noteCount = countAnalysisNotes(analysis);
  const verdict = lastReviewVerdict(rounds);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { pointerY: event.clientY, height: shownHeight };
    setDragHeight(shownHeight);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    // Up (smaller clientY) grows the strip: see the direction convention.
    setDragHeight(
      clampAnalysisStripHeight(start.height + (start.pointerY - event.clientY)),
    );
  };
  const finishDrag = () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    if (dragHeight !== null) onResize(dragHeight);
    setDragHeight(null);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target: Record<string, number> = {
      ArrowUp: shownHeight + ANALYSIS_STRIP_HEIGHT.keyboardStep,
      ArrowDown: shownHeight - ANALYSIS_STRIP_HEIGHT.keyboardStep,
      Home: ANALYSIS_STRIP_HEIGHT.min,
      End: ANALYSIS_STRIP_HEIGHT.max,
    };
    if (!(event.key in target)) return;
    event.preventDefault();
    onResize(clampAnalysisStripHeight(target[event.key]));
  };

  return (
    <div
      className="flex shrink-0 flex-col border-t border-gray-200 dark:border-gray-700"
      // Never taller than half the workspace, whatever was saved on a
      // larger window.
      style={expanded ? { height: shownHeight, maxHeight: '50%' } : undefined}
    >
      {expanded && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('translation.analysisResize')}
          aria-valuemin={ANALYSIS_STRIP_HEIGHT.min}
          aria-valuemax={ANALYSIS_STRIP_HEIGHT.max}
          aria-valuenow={shownHeight}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onKeyDown={handleKeyDown}
          className="group -mt-1 flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center focus:outline-none"
        >
          <span className="h-1 w-10 rounded-full bg-gray-300 group-hover:bg-gray-400 group-focus-visible:bg-blue-500 dark:bg-gray-600 dark:group-hover:bg-gray-500" />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg py-0.5 text-start"
        >
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
            {analysis
              ? t('translation.analysisTitle')
              : rounds.length > 0
                ? t('translation.reviewTitle')
                : t('translation.glossaryCheckTitle')}
          </span>
          {analysis && (
            <span className={CHIP_CLASS}>
              {t('translation.analysisNotes', { count: noteCount })}
            </span>
          )}
          {verdict && (
            <span className={CHIP_CLASS}>
              {t('translation.reviewSummary', {
                count: rounds.length,
                verdict:
                  verdict === 'approve'
                    ? t('translation.verdictApprove')
                    : t('translation.verdictRevise'),
              })}
            </span>
          )}
          <span className="ms-auto text-gray-500 dark:text-gray-400">
            {expanded ? (
              <IconChevronDown size={16} aria-hidden />
            ) : (
              <IconChevronUp size={16} aria-hidden />
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('translation.analysisDismiss')}
          title={t('translation.analysisDismiss')}
          className={ICON_BUTTON_CLASS}
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>
      {expanded && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AnalysisPanel
            analysis={analysis}
            rounds={rounds}
            glossaryCheck={glossaryCheck}
            showAnalysisHeading={false}
          />
        </div>
      )}
    </div>
  );
}
