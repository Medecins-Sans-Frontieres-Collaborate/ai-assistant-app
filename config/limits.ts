/**
 * Compile-time catalog of every configurable usage limit.
 *
 * This is the single source of truth for three things: what the admin UI
 * renders, what the write API accepts, and what enforcement looks up. An
 * admin can therefore never configure a limit the code does not enforce —
 * and `enforcedAt` names the file + function that does the enforcing, which
 * a test in __tests__/lib/services/limits/catalog.test.ts asserts is real.
 *
 * Pure data with no node imports, so client components may value-import it.
 *
 * ⚠ Keys are STABLE IDENTIFIERS stored inside admin policy blobs. Renaming
 * one silently orphans every override that references it. Add new keys;
 * never rename.
 *
 * DEFAULTS: almost everything is `null` (unlimited) or `true` (allowed) by
 * design — limits exist to be opted into. The only non-unlimited defaults are
 * the ones that encode behaviour the app ALREADY has today, lifted unchanged
 * so that merging this feature cannot change what any user experiences.
 */

export type LimitUnit =
  | 'requests'
  | 'tokens'
  | 'calls'
  | 'runs'
  | 'characters'
  | 'megabytes'
  | 'minutes'
  | 'jobs'
  | 'rounds'
  | 'boolean';

/**
 * `counter` — consumed over a window; needs a usage ledger and a reservation.
 * `ceiling` — a per-request maximum; needs no counter and no storage at all.
 */
export type LimitKind = 'counter' | 'ceiling';

export type LimitWindow = 'day' | 'month' | 'request' | 'none';

export type LimitCategory =
  | 'chat'
  | 'models'
  | 'files'
  | 'speech'
  | 'tools'
  | 'documents';

export interface LimitDefinition {
  /** Stable id — NEVER renamed; stored policy entries reference it. */
  key: string;
  kind: LimitKind;
  unit: LimitUnit;
  window: LimitWindow;
  /** true → may additionally be qualified by `modelId` or `series`. */
  perModel: boolean;
  /** null = unlimited, true = allowed. Where "most default to unlimited" lives. */
  defaultValue: number | null | boolean;
  /**
   * `ceiling` keys only: the compiled provider/app constraint. An admin may
   * LOWER a ceiling below this but never raise past it, because the value
   * encodes something real (a Whisper payload cap, a buffer size) rather
   * than a policy preference.
   */
  hardCeiling?: number;
  category: LimitCategory;
  /** file + function that checks this key. Asserted by the drift-guard test. */
  enforcedAt: string;
  /** i18n key suffix inside the `limits` namespace of messages/en.json. */
  labelKey: string;
}

const MEGABYTE = 1024 * 1024;

export const LIMIT_DEFINITIONS: readonly LimitDefinition[] = [
  // ── Models ────────────────────────────────────────────────────────────
  {
    key: 'model.allowed',
    kind: 'ceiling',
    unit: 'boolean',
    window: 'none',
    perModel: true,
    defaultValue: true,
    category: 'models',
    enforcedAt:
      'lib/services/chat/pipeline/Middleware.ts createLimitsMiddleware',
    labelKey: 'modelAllowed',
  },
  {
    key: 'model.requests',
    kind: 'counter',
    unit: 'requests',
    window: 'day',
    perModel: true,
    defaultValue: null,
    category: 'models',
    enforcedAt:
      'lib/services/chat/pipeline/Middleware.ts createLimitsMiddleware',
    labelKey: 'modelRequestsPerDay',
  },

  // ── Chat totals (model-agnostic backstop) ─────────────────────────────
  {
    key: 'chat.messagesPerDay',
    kind: 'counter',
    unit: 'requests',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'chat',
    enforcedAt:
      'lib/services/chat/pipeline/Middleware.ts createLimitsMiddleware',
    labelKey: 'chatMessagesPerDay',
  },
  {
    key: 'chat.tokensPerDay',
    kind: 'counter',
    unit: 'tokens',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'chat',
    enforcedAt: 'lib/services/limits/tokenDebit.ts debitTokenUsage',
    labelKey: 'chatTokensPerDay',
  },
  {
    key: 'chat.tokensPerMonth',
    kind: 'counter',
    unit: 'tokens',
    window: 'month',
    perModel: false,
    defaultValue: null,
    category: 'chat',
    enforcedAt: 'lib/services/limits/tokenDebit.ts debitTokenUsage',
    labelKey: 'chatTokensPerMonth',
  },

  // ── Feature on/off ────────────────────────────────────────────────────
  {
    key: 'feature.webSearch.enabled',
    kind: 'ceiling',
    unit: 'boolean',
    window: 'none',
    perModel: false,
    defaultValue: true,
    category: 'tools',
    enforcedAt:
      'lib/services/chat/pipeline/Middleware.ts createLimitsMiddleware',
    labelKey: 'webSearchEnabled',
  },
  {
    key: 'feature.codeInterpreter.enabled',
    kind: 'ceiling',
    unit: 'boolean',
    window: 'none',
    perModel: false,
    defaultValue: true,
    category: 'tools',
    enforcedAt:
      'lib/services/chat/pipeline/Middleware.ts createLimitsMiddleware',
    labelKey: 'codeInterpreterEnabled',
  },
  {
    key: 'feature.mcp.enabled',
    kind: 'ceiling',
    unit: 'boolean',
    window: 'none',
    perModel: false,
    defaultValue: true,
    category: 'tools',
    enforcedAt:
      'lib/services/chat/pipeline/Middleware.ts createLimitsMiddleware',
    labelKey: 'mcpEnabled',
  },

  // ── Per-request ceilings ──────────────────────────────────────────────
  {
    key: 'feature.tts.charactersPerRequest',
    kind: 'ceiling',
    unit: 'characters',
    window: 'request',
    perModel: false,
    defaultValue: null,
    category: 'speech',
    enforcedAt: 'app/api/chat/tts/route.ts POST',
    labelKey: 'ttsCharactersPerRequest',
  },
  {
    key: 'feature.upload.megabytesPerFile',
    kind: 'ceiling',
    unit: 'megabytes',
    window: 'request',
    perModel: false,
    defaultValue: null,
    // Today's largest category gate (VIDEO_MAX_BYTES, 1.5GB) — an admin may
    // lower the effective cap but never raise it past what the upload path
    // is actually built to buffer.
    hardCeiling: Math.floor((1.5 * 1024 * MEGABYTE) / MEGABYTE),
    category: 'files',
    enforcedAt: 'app/api/file/upload/route.ts effectiveUploadMegabytes',
    labelKey: 'uploadMegabytesPerFile',
  },
  {
    key: 'feature.mcp.roundsPerRequest',
    kind: 'ceiling',
    unit: 'rounds',
    window: 'request',
    perModel: false,
    // Today's MAX_TOOL_ROUNDS (lib/services/mcp/toolLoopCore.ts:51), lifted
    // unchanged so behaviour is identical on merge.
    defaultValue: 5,
    hardCeiling: 25,
    category: 'tools',
    enforcedAt:
      'lib/services/chat/pipeline/Middleware.ts createLimitsMiddleware',
    labelKey: 'mcpRoundsPerRequest',
  },

  // ── Per-feature counters ──────────────────────────────────────────────
  {
    key: 'feature.tts.charactersPerDay',
    kind: 'counter',
    unit: 'characters',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'speech',
    enforcedAt: 'app/api/chat/tts/route.ts POST',
    labelKey: 'ttsCharactersPerDay',
  },
  {
    key: 'feature.transcription.minutesPerDay',
    kind: 'counter',
    unit: 'minutes',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'speech',
    enforcedAt:
      'lib/services/limits/transcriptionBudget.ts guardTranscriptionMinutes',
    labelKey: 'transcriptionMinutesPerDay',
  },
  {
    key: 'feature.translation.jobsPerDay',
    kind: 'counter',
    unit: 'jobs',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'documents',
    enforcedAt: 'app/api/document-translation/translate/route.ts POST',
    labelKey: 'translationJobsPerDay',
  },
  {
    key: 'feature.webSearch.callsPerDay',
    kind: 'counter',
    unit: 'calls',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'tools',
    enforcedAt:
      'lib/services/chat/enrichers/ToolRouterEnricher.ts executeWebSearch',
    labelKey: 'webSearchCallsPerDay',
  },
  {
    key: 'feature.m365.toolCallsPerDay',
    kind: 'counter',
    unit: 'calls',
    window: 'day',
    perModel: false,
    // Aggregate across all M365 tools. Non-null default: the toolset is new
    // (flag-gated), so a cap cannot change behaviour any user already has.
    defaultValue: 200,
    category: 'tools',
    // The key literal lives in the executor (per-spec budgetKey default);
    // the handler passes keys through generically.
    enforcedAt: 'lib/services/m365/tools/executor.ts callTool',
    labelKey: 'm365ToolCallsPerDay',
  },
  {
    key: 'feature.m365.mail.readsPerDay',
    kind: 'counter',
    unit: 'calls',
    window: 'day',
    perModel: false,
    // Generous: search + get + thread combined (fifth pass tier 1).
    defaultValue: 300,
    category: 'tools',
    enforcedAt: 'lib/services/m365/tools/toolCatalog.ts budgetKey',
    labelKey: 'm365MailReadsPerDay',
  },
  {
    key: 'feature.m365.mail.draftsPerDay',
    kind: 'counter',
    unit: 'calls',
    window: 'day',
    perModel: false,
    // Deliberately tight: every draft is a confirmed mailbox write, and the
    // cap is the volume-abuse backstop behind the per-draft consent card.
    defaultValue: 25,
    category: 'tools',
    enforcedAt: 'lib/services/m365/tools/toolCatalog.ts budgetKey',
    labelKey: 'm365MailDraftsPerDay',
  },
  {
    key: 'feature.m365.mail.deepScansPerDay',
    kind: 'counter',
    unit: 'calls',
    window: 'day',
    perModel: false,
    // One composite = one unit regardless of internal fan-out.
    defaultValue: 20,
    category: 'tools',
    enforcedAt: 'lib/services/m365/tools/toolCatalog.ts budgetKey',
    labelKey: 'm365MailDeepScansPerDay',
  },
  {
    key: 'feature.codeInterpreter.runsPerDay',
    kind: 'counter',
    unit: 'runs',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'tools',
    enforcedAt:
      'lib/services/chat/enrichers/ToolRouterEnricher.ts executeCodeInterpreter',
    labelKey: 'codeInterpreterRunsPerDay',
  },
  {
    key: 'feature.upload.filesPerDay',
    kind: 'counter',
    unit: 'jobs',
    window: 'day',
    perModel: false,
    defaultValue: null,
    category: 'files',
    enforcedAt: 'app/api/file/upload/route.ts POST',
    labelKey: 'uploadFilesPerDay',
  },
] as const;

export const LIMIT_KEYS: ReadonlySet<string> = new Set(
  LIMIT_DEFINITIONS.map((d) => d.key),
);

const DEFINITIONS_BY_KEY = new Map(LIMIT_DEFINITIONS.map((d) => [d.key, d]));

export function getLimitDefinition(key: string): LimitDefinition | undefined {
  return DEFINITIONS_BY_KEY.get(key);
}

/**
 * Counter cell names as stored in a usage document. A per-model limit is
 * counted separately per model id and per series, so `model.requests` becomes
 * `model:gpt-5.2.requests` and `family:gpt.requests`. Both are checked
 * CONJUNCTIVELY: a family cap is an envelope, a model cap a sub-cap.
 */
export function modelCounterCell(key: string, modelId: string): string {
  return `model:${modelId.toLowerCase()}.${key.split('.').pop()}`;
}

export function familyCounterCell(key: string, series: string): string {
  return `family:${series.toLowerCase()}.${key.split('.').pop()}`;
}

/**
 * Model/series qualifiers are validated by SHAPE only, never against the live
 * catalog: model ids come from always-on Foundry discovery and vary per ring,
 * so a limit pinned to a model absent from THIS ring must still persist.
 */
export const DIMENSION_RE = /^[a-z0-9._:-]{1,64}$/;

export function isValidDimension(value: string): boolean {
  return DIMENSION_RE.test(value.toLowerCase());
}
