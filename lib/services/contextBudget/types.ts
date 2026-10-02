/**
 * Admin-controlled context budget: how much conversation HISTORY is sent to
 * a model on each turn.
 *
 * ONE document (`system/context-budget/config.json`) in the centralized
 * admin container, edited only by global admins. Before this existed the
 * server trimmed history to the model's `tokenLimit` — its OUTPUT
 * reservation — so every GPT-5.x model saw at most ~16k tokens of a 128k
 * window while Claude saw 128k. The budget is now an explicit number with
 * the window as its ceiling, per family and per model where needed.
 *
 * EVERY field has a fallback written in code (`CONTEXT_BUDGET_DEFAULTS`).
 * The stored document only ever overrides — an absent document, an
 * unreadable blob, or a single malformed field all resolve to the code
 * default for the affected value, so chat never depends on this
 * configuration existing.
 */
import { z } from 'zod';

export const CONTEXT_BUDGET_CONFIG_PREFIX = 'system/context-budget/';
export const CONTEXT_BUDGET_CONFIG_PATH = `${CONTEXT_BUDGET_CONFIG_PREFIX}config.json`;
export const CONTEXT_BUDGET_CONFIG_HISTORY_PREFIX = `${CONTEXT_BUDGET_CONFIG_PREFIX}history/`;

/** Inclusive bounds for the numeric settings (UI and server share them). */
export const CONTEXT_BUDGET_BOUNDS = {
  historyTokens: { min: 4_000, max: 400_000 },
  historyFraction: { min: 0.1, max: 0.95 },
  minRecentMessages: { min: 1, max: 10 },
  overrideTokens: { min: 4_000, max: 1_000_000 },
} as const;

export interface ResolvedContextBudgetConfig {
  /**
   * Tokens of conversation history a turn may carry, system prompt
   * included, unless a family or model override says otherwise.
   */
  historyTokens: number;
  /**
   * Ceiling as a share of the model's input room (context window minus
   * its output reservation). A budget larger than this is clamped, so a
   * small-window model is never asked for more than it can hold.
   */
  historyFraction: number;
  /**
   * Messages always kept (counting back from the latest), even over budget
   * — within the window. Three keeps the previous exchange when the latest
   * message alone (file text, search results) would otherwise fill the
   * budget and leave the model with no history at all.
   */
  minRecentMessages: number;
  /** Budget per model family (`series`), replacing `historyTokens`. */
  familyOverrides: Record<string, number>;
  /** Budget per model id, replacing both of the above. */
  modelOverrides: Record<string, number>;
}

/**
 * 48k for the mainstream 128k-window models: a conversation keeps roughly
 * its last 30-60 exchanges instead of 5-15, at about three times the
 * previous input cost per long turn rather than seven (the full window).
 * Claude keeps the 128k it has always had.
 */
export const CONTEXT_BUDGET_DEFAULTS: ResolvedContextBudgetConfig = {
  historyTokens: 48_000,
  historyFraction: 0.75,
  minRecentMessages: 3,
  familyOverrides: { claude: 128_000 },
  modelOverrides: {},
};

const bounded = (bounds: { min: number; max: number }) =>
  z.number().int().min(bounds.min).max(bounds.max);
const overrideMap = (strict: boolean) => {
  const value = bounded(CONTEXT_BUDGET_BOUNDS.overrideTokens);
  const key = z.string().min(1).max(120);
  return strict
    ? z.record(key, value)
    : z
        .record(key, value.catch(undefined as unknown as number))
        .transform((map) =>
          Object.fromEntries(
            Object.entries(map).filter(
              ([, tokens]) => typeof tokens === 'number',
            ),
          ),
        );
};

/**
 * Read schema. Every field is optional AND individually fault-tolerant
 * (`.catch(undefined)`): a value this build cannot accept — out of range, a
 * type a newer build introduced — falls back to the code default for that
 * field alone instead of voiding the whole document.
 */
export const ContextBudgetSettingsSchema = z.object({
  historyTokens: bounded(CONTEXT_BUDGET_BOUNDS.historyTokens)
    .optional()
    .catch(undefined),
  historyFraction: z
    .number()
    .min(CONTEXT_BUDGET_BOUNDS.historyFraction.min)
    .max(CONTEXT_BUDGET_BOUNDS.historyFraction.max)
    .optional()
    .catch(undefined),
  minRecentMessages: bounded(CONTEXT_BUDGET_BOUNDS.minRecentMessages)
    .optional()
    .catch(undefined),
  familyOverrides: overrideMap(false).optional().catch(undefined),
  modelOverrides: overrideMap(false).optional().catch(undefined),
});
export type ContextBudgetSettings = z.infer<typeof ContextBudgetSettingsSchema>;

export const ContextBudgetConfigSchema = z.object({
  version: z.literal(1),
  budget: ContextBudgetSettingsSchema.default({}),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type ContextBudgetConfig = z.infer<typeof ContextBudgetConfigSchema>;

/**
 * Write schema — strict where the read schema is lenient: an admin's save
 * must be rejected, not silently defaulted, when a value is out of range.
 */
export const ContextBudgetSettingsWriteSchema = z
  .object({
    historyTokens: bounded(CONTEXT_BUDGET_BOUNDS.historyTokens).optional(),
    historyFraction: z
      .number()
      .min(CONTEXT_BUDGET_BOUNDS.historyFraction.min)
      .max(CONTEXT_BUDGET_BOUNDS.historyFraction.max)
      .optional(),
    minRecentMessages: bounded(
      CONTEXT_BUDGET_BOUNDS.minRecentMessages,
    ).optional(),
    familyOverrides: overrideMap(true).optional(),
    modelOverrides: overrideMap(true).optional(),
  })
  .strict();

export const ContextBudgetConfigHistoryEntrySchema = z.object({
  version: z.literal(1),
  config: ContextBudgetConfigSchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type ContextBudgetConfigHistoryEntry = z.infer<
  typeof ContextBudgetConfigHistoryEntrySchema
>;

/**
 * Effective settings under a (possibly absent) document: stored values over
 * the code defaults. An override map that is present REPLACES the default
 * map — an admin who clears the Claude override gets exactly what they
 * saved — while an absent one keeps the default.
 */
export function resolveContextBudgetConfig(
  config: ContextBudgetConfig | null | undefined,
): ResolvedContextBudgetConfig {
  const stored = config?.budget ?? {};
  return {
    historyTokens:
      stored.historyTokens ?? CONTEXT_BUDGET_DEFAULTS.historyTokens,
    historyFraction:
      stored.historyFraction ?? CONTEXT_BUDGET_DEFAULTS.historyFraction,
    minRecentMessages:
      stored.minRecentMessages ?? CONTEXT_BUDGET_DEFAULTS.minRecentMessages,
    familyOverrides:
      stored.familyOverrides ?? CONTEXT_BUDGET_DEFAULTS.familyOverrides,
    modelOverrides:
      stored.modelOverrides ?? CONTEXT_BUDGET_DEFAULTS.modelOverrides,
  };
}

/** What the server trims a turn's history to, for one model. */
export interface HistoryBudget {
  /** Tokens for history, the system prompt included. */
  tokens: number;
  /**
   * The model's real input room (window minus output reservation): the
   * hard ceiling `minRecentMessages` may reach past `tokens`.
   */
  windowTokens: number;
  minRecentMessages: number;
}

/**
 * The budget for `model`: the model override, else the family override,
 * else the standard budget — never more than `historyFraction` of the
 * model's input room. A model whose window is unknown (0) or no larger
 * than its output reservation keeps the old rule, its `tokenLimit`.
 */
export function resolveHistoryBudget(
  model: {
    id: string;
    maxLength: number;
    tokenLimit: number;
    series?: string;
  },
  config: ResolvedContextBudgetConfig,
): HistoryBudget {
  const windowTokens = Math.max(0, model.maxLength - model.tokenLimit);
  const minRecentMessages = config.minRecentMessages;
  if (windowTokens <= 0) {
    return {
      tokens: model.tokenLimit,
      windowTokens: model.tokenLimit,
      minRecentMessages,
    };
  }
  const requested =
    config.modelOverrides[model.id] ??
    (model.series ? config.familyOverrides[model.series] : undefined) ??
    config.historyTokens;
  const ceiling = Math.floor(windowTokens * config.historyFraction);
  return {
    tokens: Math.max(1, Math.min(requested, ceiling)),
    windowTokens,
    minRecentMessages,
  };
}

export function historyBlobPath(timestamp: string, updatedBy: string): string {
  const safeTs = timestamp.replace(/[^0-9TZ]/g, '');
  const safeBy = updatedBy.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
  return `${CONTEXT_BUDGET_CONFIG_HISTORY_PREFIX}${safeTs}-${safeBy}.json`;
}
