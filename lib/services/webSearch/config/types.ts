/**
 * Admin-controlled web search configuration (docs/WEB_SEARCH_MULTI_STEP.md).
 *
 * ONE document (`system/web-search/config.json`) in the centralized admin
 * container, edited only by global admins. It tunes the multi-step search
 * that runs on MSF's own SearXNG instance: whether it runs at all, which
 * model assesses each step, and how far a single question may go.
 *
 * EVERY field has a fallback written in code (`MULTI_STEP_DEFAULTS`). The
 * stored document only ever overrides — an absent document, an unreadable
 * blob, or a single malformed field all resolve to the code default for the
 * affected value, so search never depends on this configuration existing.
 */
import { z } from 'zod';

export const WEB_SEARCH_CONFIG_PREFIX = 'system/web-search/';
export const WEB_SEARCH_CONFIG_PATH = `${WEB_SEARCH_CONFIG_PREFIX}config.json`;
export const WEB_SEARCH_CONFIG_HISTORY_PREFIX = `${WEB_SEARCH_CONFIG_PREFIX}history/`;

/**
 * Default assessor: Mistral Large 3 — a non-reasoning model (no hidden
 * thinking latency between steps) that is cheap per call and strong enough
 * to judge whether a set of sources answers a question. The assessor falls
 * back to `ASSESSOR_FALLBACK_MODEL_ID` when the chosen model cannot be
 * called, so a missing deployment degrades instead of breaking the loop.
 */
export const DEFAULT_ASSESSOR_MODEL_ID = 'Mistral-Large-3';

/**
 * The tool router's own model: it just planned this very search, so its
 * deployment is known to be reachable in the environment.
 */
export const ASSESSOR_FALLBACK_MODEL_ID = 'gpt-5.4-nano';

/** Inclusive bounds for the numeric settings (UI and server share them). */
export const MULTI_STEP_BOUNDS = {
  maxSteps: { min: 1, max: 8 },
  maxStepsExploratory: { min: 1, max: 12 },
  maxPageReadsPerStep: { min: 1, max: 5 },
  timeBudgetSeconds: { min: 20, max: 180 },
} as const;

export interface ResolvedMultiStepConfig {
  /** Master switch. Off = every search is the single planned batch. */
  enabled: boolean;
  /** Catalog id of the model that assesses each step. */
  assessorModelId: string;
  /**
   * Steps one question may take, the first search included. Every further
   * search or batch of page reads is one step.
   */
  maxSteps: number;
  /**
   * The higher cap for tasks the assessor classes as an exploratory hunt
   * (one hard-to-find item, dead ends expected). Never below `maxSteps`.
   */
  maxStepsExploratory: number;
  /** Whether a step may open result pages to read their text. */
  pageReads: boolean;
  maxPageReadsPerStep: number;
  /** Whether the assessor labels source quality for the answering model. */
  sourceAssessment: boolean;
  /** Wall-clock budget for the whole search, first round included. */
  timeBudgetSeconds: number;
}

export const MULTI_STEP_DEFAULTS: ResolvedMultiStepConfig = {
  enabled: true,
  assessorModelId: DEFAULT_ASSESSOR_MODEL_ID,
  maxSteps: 3,
  maxStepsExploratory: 6,
  pageReads: true,
  maxPageReadsPerStep: 3,
  sourceAssessment: true,
  timeBudgetSeconds: 90,
};

const bounded = (bounds: { min: number; max: number }) =>
  z.number().int().min(bounds.min).max(bounds.max);

/**
 * Read schema. Every field is optional AND individually fault-tolerant
 * (`.catch(undefined)`): a value this build cannot accept — out of range, a
 * type a newer build introduced — falls back to the code default for that
 * field alone instead of voiding the whole document.
 */
export const MultiStepSettingsSchema = z.object({
  enabled: z.boolean().optional().catch(undefined),
  assessorModelId: z.string().min(1).max(120).optional().catch(undefined),
  maxSteps: bounded(MULTI_STEP_BOUNDS.maxSteps).optional().catch(undefined),
  maxStepsExploratory: bounded(MULTI_STEP_BOUNDS.maxStepsExploratory)
    .optional()
    .catch(undefined),
  pageReads: z.boolean().optional().catch(undefined),
  maxPageReadsPerStep: bounded(MULTI_STEP_BOUNDS.maxPageReadsPerStep)
    .optional()
    .catch(undefined),
  sourceAssessment: z.boolean().optional().catch(undefined),
  timeBudgetSeconds: bounded(MULTI_STEP_BOUNDS.timeBudgetSeconds)
    .optional()
    .catch(undefined),
});
export type MultiStepSettings = z.infer<typeof MultiStepSettingsSchema>;

export const WebSearchConfigSchema = z.object({
  version: z.literal(1),
  multiStep: MultiStepSettingsSchema.default({}),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

/**
 * Write schema — strict where the read schema is lenient: an admin's save
 * must be rejected, not silently defaulted, when a value is out of range.
 */
export const MultiStepSettingsWriteSchema = z
  .object({
    enabled: z.boolean().optional(),
    assessorModelId: z.string().min(1).max(120).optional(),
    maxSteps: bounded(MULTI_STEP_BOUNDS.maxSteps).optional(),
    maxStepsExploratory: bounded(
      MULTI_STEP_BOUNDS.maxStepsExploratory,
    ).optional(),
    pageReads: z.boolean().optional(),
    maxPageReadsPerStep: bounded(
      MULTI_STEP_BOUNDS.maxPageReadsPerStep,
    ).optional(),
    sourceAssessment: z.boolean().optional(),
    timeBudgetSeconds: bounded(MULTI_STEP_BOUNDS.timeBudgetSeconds).optional(),
  })
  .strict();

export const WebSearchConfigHistoryEntrySchema = z.object({
  version: z.literal(1),
  config: WebSearchConfigSchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type WebSearchConfigHistoryEntry = z.infer<
  typeof WebSearchConfigHistoryEntrySchema
>;

/**
 * Effective multi-step settings under a (possibly absent) document: stored
 * values over the code defaults. `isAllowedAssessorModel` lets the caller
 * reject a stored model id the catalog no longer offers (retired, renamed),
 * which then resolves to the default assessor.
 */
export function resolveMultiStepConfig(
  config: WebSearchConfig | null | undefined,
  isAllowedAssessorModel: (id: string) => boolean = () => true,
): ResolvedMultiStepConfig {
  const stored = config?.multiStep ?? {};
  const maxSteps = stored.maxSteps ?? MULTI_STEP_DEFAULTS.maxSteps;
  const assessorModelId =
    stored.assessorModelId && isAllowedAssessorModel(stored.assessorModelId)
      ? stored.assessorModelId
      : MULTI_STEP_DEFAULTS.assessorModelId;
  return {
    enabled: stored.enabled ?? MULTI_STEP_DEFAULTS.enabled,
    assessorModelId,
    maxSteps,
    // The exploratory cap extends the normal one; it can never undercut it.
    maxStepsExploratory: Math.max(
      maxSteps,
      stored.maxStepsExploratory ?? MULTI_STEP_DEFAULTS.maxStepsExploratory,
    ),
    pageReads: stored.pageReads ?? MULTI_STEP_DEFAULTS.pageReads,
    maxPageReadsPerStep:
      stored.maxPageReadsPerStep ?? MULTI_STEP_DEFAULTS.maxPageReadsPerStep,
    sourceAssessment:
      stored.sourceAssessment ?? MULTI_STEP_DEFAULTS.sourceAssessment,
    timeBudgetSeconds:
      stored.timeBudgetSeconds ?? MULTI_STEP_DEFAULTS.timeBudgetSeconds,
  };
}

export function historyBlobPath(timestamp: string, updatedBy: string): string {
  const safeTs = timestamp.replace(/[^0-9TZ]/g, '');
  const safeBy = updatedBy.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
  return `${WEB_SEARCH_CONFIG_HISTORY_PREFIX}${safeTs}-${safeBy}.json`;
}
