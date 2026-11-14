/**
 * Pure helpers behind the Translation workspace's progress and paper-trail
 * UI: which step a run is on, how the paper trail is summarized, and the
 * bounds of the resizable analysis strip.
 */
import {
  TranslationAnalysis,
  TranslationReviewRound,
  TranslationWorkflowState,
} from '@/types/workflow';

/**
 * Activity keys the translation run reports (`chat.activity.*` messages).
 *
 * ACTIVITY KEY CONVENTION: the server orchestrator emits these and the
 * workspace derives the current step from them, so both sides import the
 * keys from here instead of repeating the strings.
 */
export const TRANSLATION_ACTIVITY = {
  analyzing: 'chat.activity.workflow.analyzingSource',
  translating: 'chat.activity.workflow.translating',
  reviewing: 'chat.activity.workflow.reviewingTranslation',
} as const;

/** A step of a translation run, in the order it happens. */
export type TranslationRunStage = 'analyzing' | 'translating' | 'reviewing';

/** Where a step stands relative to the one in progress. */
export type ProgressStepStatus = 'done' | 'active' | 'upcoming';

/** One step of a progress indicator. */
export interface ProgressStep<Id extends string = string> {
  id: Id;
  status: ProgressStepStatus;
}

const STAGES_BY_MODE: Record<
  TranslationWorkflowState['mode'],
  TranslationRunStage[]
> = {
  quick: ['translating'],
  agentic: ['analyzing', 'translating', 'reviewing'],
};

/**
 * The step a run is on, from its latest activity.
 *
 * @param activityKey - Latest activity key of the run, if any arrived yet.
 * @param mode - The run's mode.
 * @returns The current step. Before the first activity arrives, the first
 *   step of the mode, since the request is already on its way to it.
 */
export function deriveRunStage(
  activityKey: string | undefined,
  mode: TranslationWorkflowState['mode'],
): TranslationRunStage {
  const stages = STAGES_BY_MODE[mode];
  const reported = (
    Object.keys(TRANSLATION_ACTIVITY) as TranslationRunStage[]
  ).find((stage) => TRANSLATION_ACTIVITY[stage] === activityKey);
  return reported && stages.includes(reported) ? reported : stages[0];
}

/**
 * Marks each of an ordered list of steps as done, active, or upcoming.
 *
 * @param order - Step ids in the order they happen.
 * @param active - The step in progress. An id not in `order` leaves every
 *   step upcoming.
 */
export function buildProgressSteps<Id extends string>(
  order: readonly Id[],
  active: Id,
): ProgressStep<Id>[] {
  const activeIndex = order.indexOf(active);
  return order.map((id, index) => ({
    id,
    status:
      activeIndex === -1 || index > activeIndex
        ? 'upcoming'
        : index === activeIndex
          ? 'active'
          : 'done',
  }));
}

/**
 * The steps of a translation run, ending with a `done` step that stays
 * upcoming for as long as the run is in progress.
 *
 * @param mode - The run's mode.
 * @param stage - The step in progress.
 */
export function translationRunSteps(
  mode: TranslationWorkflowState['mode'],
  stage: TranslationRunStage,
): ProgressStep<TranslationRunStage | 'done'>[] {
  return buildProgressSteps<TranslationRunStage | 'done'>(
    [...STAGES_BY_MODE[mode], 'done'],
    stage,
  );
}

/**
 * Formats a duration as minutes and seconds, e.g. `0:07` or `12:40`.
 *
 * @param seconds - Elapsed seconds; negatives and fractions are floored at 0.
 */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Number of findings in a pre-translation analysis. */
export function countAnalysisNotes(analysis?: TranslationAnalysis): number {
  if (!analysis) return 0;
  return analysis.trickyTerms.length + analysis.ambiguities.length;
}

/** Verdict of the last review round, or undefined when no round ran. */
export function lastReviewVerdict(
  rounds: TranslationReviewRound[],
): TranslationReviewRound['verdict'] | undefined {
  return rounds[rounds.length - 1]?.verdict;
}

/**
 * Whether a run left anything to show in the analysis strip. Mirrors what
 * the strip renders: analysis, review rounds, or a glossary check that
 * actually checked a term.
 */
export function hasPaperTrail(
  state: Pick<
    TranslationWorkflowState,
    'analysis' | 'rounds' | 'glossaryCheck'
  >,
): boolean {
  return (
    !!state.analysis ||
    state.rounds.length > 0 ||
    (state.glossaryCheck?.checkedTerms ?? 0) > 0
  );
}

/** Height bounds of the expanded analysis strip, in CSS pixels. */
export const ANALYSIS_STRIP_HEIGHT = {
  min: 96,
  max: 560,
  default: 224,
  /** Distance one arrow-key press moves the resize handle. */
  keyboardStep: 24,
} as const;

/**
 * Clamps a requested strip height to the allowed range.
 *
 * @param height - Requested height in CSS pixels; a non-finite value falls
 *   back to the default.
 */
export function clampAnalysisStripHeight(height: number): number {
  if (!Number.isFinite(height)) return ANALYSIS_STRIP_HEIGHT.default;
  return Math.round(
    Math.min(
      ANALYSIS_STRIP_HEIGHT.max,
      Math.max(ANALYSIS_STRIP_HEIGHT.min, height),
    ),
  );
}
