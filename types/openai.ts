import modelMetadata from '@/config/models.json';
import { z } from 'zod';

export interface OpenAIModel {
  id: string;
  name: string;
  maxLength: number; // Input context window (in tokens)
  tokenLimit: number; // Maximum output tokens
  temperature?: number;
  stream?: boolean;
  modelType?: 'foundational' | 'omni' | 'reasoning' | 'agent';
  description?: string;
  /**
   * Short, user-facing one-liner shown in the model list (e.g. "Best for
   * most tasks", "Faster and lower cost"). Helps users decide without
   * opening the details panel. Aim for ≤6 words.
   */
  tagline?: string;
  /**
   * Marks the model as the recommended default. Pinned to the top of the
   * list and rendered with a "Recommended" pill so first-time users have
   * a clear "start here" signal. Exactly one model should be flagged.
   */
  isRecommended?: boolean;
  isDisabled?: boolean;
  isAgent?: boolean;
  isCustomAgent?: boolean; // User-created custom agent (vs built-in agent)
  isOrganizationAgent?: boolean; // Organization-defined agent (e.g., MSF Communications bot)
  agentId?: string; // Azure AI Foundry agent name (or legacy asst_xxx ID)
  /** Agent version the Application's deployment routes to. Required in the
   * agent_reference body when invoking via the project endpoint. */
  agentVersion?: string;
  foundryEndpoint?: string; // Foundry project endpoint for this agent (for custom sources)
  /**
   * ARM resource path of the Foundry project this agent was discovered from.
   * Used as a cache disambiguator + lazy-discovery scope at chat time so the
   * same agent name from different projects routes to the right endpoint.
   * Server validates against `isValidFoundryResourcePath` before any use.
   */
  agentSource?: string;
  provider?:
    | 'openai'
    | 'deepseek'
    | 'xai'
    | 'meta'
    | 'anthropic'
    | 'mistral'
    | 'moonshot'; // Model provider
  knowledgeCutoffDate?: string; // ISO format for sorting and display (e.g., "2025-01" or "2025-01-20")
  sdk?: 'azure-openai' | 'openai' | 'anthropic-foundry'; // Which SDK this model requires
  supportsTemperature?: boolean; // Whether this model supports custom temperature values
  supportsVision?: boolean; // Whether this model can accept image input. Source of truth for OpenAIVisionModelID (derived below).
  /**
   * Whether this model supports function/tool calling well enough for the
   * MCP tool loop (chat.completions `tools`). Absent = false (fail safe):
   * models without it silently skip MCP even when servers are configured.
   */
  supportsTools?: boolean;
  deploymentName?: string; // Azure AI Foundry deployment name (for third-party models)

  /**
   * ARM ACCOUNT path of the user-added custom model source ("BYO model")
   * this model was discovered from. Server-resolved routing hint only: the
   * chat server re-validates the path and re-resolves the deployment under
   * the user's own OBO token — the value is NEVER trusted from the client.
   */
  modelSource?: string;
  /**
   * Model discovered from a user-added custom model source (BYO). Rendered
   * in its own picker section and exempt from app-level curation/gating —
   * the user's own ARM RBAC is the authorization. Server-set; never
   * client-trusted.
   */
  isCustomSourceModel?: boolean;
  /**
   * Azure region of the byom source ACCOUNT (display only, e.g.
   * "swedencentral"). Runtime-only like hostedIn — set by /api/models/sources,
   * deliberately NOT in the zod openAIModelSchema (never authored in config).
   */
  sourceLocation?: string;
  /**
   * The ARM deployment's underlying model version (display only, e.g.
   * "2025-04-14"). Runtime-only like hostedIn — set from discovery,
   * deliberately NOT in the zod openAIModelSchema (never authored in config).
   */
  deploymentModelVersion?: string;

  /**
   * Regions where a deployment with this name was discovered (set by
   * /api/models at runtime, never authored in config/models.json). Absent on
   * the static list — clients treat absent as available-in-home-region. See
   * isModelSelectableInRegion (lib/utils/shared/modelRegion.ts).
   */
  hostedIn?: ('US' | 'EU')[];
  /**
   * Where inference runs. 'azure' (default when absent) = inside MSF's Azure
   * environment; 'external' = the provider's own infrastructure reached
   * through Azure AI Foundry (currently the claude-* models). Compliance
   * disclosure — deliberately NOT settable via ARM ui-* tags. Read through
   * getModelHosting() so the default lives in one place.
   */
  hosting?: 'azure' | 'external';
  /**
   * Picker curation tier: 'featured' models are DEFAULT FAVORITES (surface in
   * the Favorites section until the user unstars them), 'legacy' versions are
   * hidden by default inside their series' chip strip, 'standard' (default
   * when absent) renders normally. Read through getModelTier().
   */
  tier?: 'featured' | 'standard' | 'legacy';

  /**
   * Rough parameter-scale class, used by the emissions estimator
   * (config/emissions.json maps each class to Wh per 1k tokens). Default
   * when absent: 'standard' (see getModelSizeClass).
   */
  sizeClass?: 'nano' | 'mini' | 'standard' | 'large';

  /**
   * FAMILY key shared by every member of the same model family (e.g. 'gpt',
   * 'gpt-chat', 'claude', 'deepseek'). Models sharing a series render as ONE
   * picker row; within the row, members are organized on two axes — `variant`
   * (size/tier segments) and `versionLabel` (chips, filtered to the active
   * variant). Models without a series render as plain rows.
   */
  series?: string;
  /** Display name of the family row (e.g. "GPT", "Claude"). Same value on every member. */
  seriesLabel?: string;
  /** Short version chip text (e.g. "5.4", "4o", "4.6"). */
  versionLabel?: string;
  /**
   * Variant key within a family — the second in-row axis (e.g. 'standard' |
   * 'mini' | 'nano' for GPT sizes, 'opus' | 'sonnet' | 'haiku' for Claude
   * tiers, 'standard' | 'reasoning' for DeepSeek). Absent = single-variant
   * family (the row behaves as a plain version series). Picker-only.
   */
  variant?: string;
  /** Display label of the variant segment (e.g. "Mini", "Opus", "Reasoning"). Same value on every member of the variant. */
  variantLabel?: string;
  /**
   * Display position of this model's variant segment within its family row
   * (1 = first). Same value on every member of the variant; encodes the
   * capability hierarchy (e.g. Opus 1, Sonnet 2, Haiku 3). Variants without
   * a rank sort after ranked ones, in order of appearance.
   */
  variantRank?: number;
  /**
   * Family-default preference: when nothing in the family is selected, the
   * row fronts (and selects) the AVAILABLE model with the LOWEST rank;
   * same-rank ties go to the newest version, so "rank 1 on every Sonnet"
   * means "latest available Sonnet" without per-version upkeep. Unranked
   * members are only faced via the featured/newest fallbacks.
   */
  defaultRank?: number;

  /**
   * Azure Foundry lifecycle stage of the underlying model version, mirrored
   * from Microsoft's model retirement schedule (see the $retirement-note in
   * config/models.json for source + as-of date). INFORMATIONAL ONLY — never
   * used for gating. A deployment can outlive its model version's schedule:
   * Azure upgrades deployments in place, so e.g. a deployment named
   * "gpt-5.2-chat" may run a newer underlying model even though the
   * gpt-5.2-chat model version itself is retired.
   */
  lifecycle?: 'preview' | 'ga' | 'legacy' | 'deprecated' | 'retired';
  /** Azure's scheduled retirement date (YYYY-MM-DD) for the underlying model version. Absent = no announced date. */
  retirementDate?: string;
  /** Replacement model id suggested by the Azure retirement schedule, if any. */
  retirementReplacement?: string;

  // Advanced reasoning model parameters
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; // Current reasoning effort setting
  supportsReasoningEffort?: boolean; // Whether model supports reasoning_effort parameter
  supportsMinimalReasoning?: boolean; // Whether model supports 'minimal' reasoning effort (GPT-5 only)
  verbosity?: 'low' | 'medium' | 'high'; // Current verbosity setting
  supportsVerbosity?: boolean; // Whether model supports verbosity parameter

  // Special handling flags
  avoidSystemPrompt?: boolean; // For DeepSeek-R1: merge system prompt into user message
  usesResponsesAPI?: boolean; // Uses Azure responses.create() instead of chat.completions
}

// Model order determines display order in UI (most advanced first)
export enum OpenAIModelID {
  GPT_5_2 = 'gpt-5.2',
  GPT_5_2_CHAT = 'gpt-5.2-chat',
  GPT_o3 = 'o3',
  GPT_5_MINI = 'gpt-5-mini',
  GPT_4_1 = 'gpt-4.1',
  GPT_5_4 = 'gpt-5.4',
  GPT_5_4_NANO = 'gpt-5.4-nano',
  GPT_5_3_CHAT = 'gpt-5.3-chat',
  GPT_5 = 'gpt-5',
  GPT_5_CHAT = 'gpt-5-chat',
  GPT_4O = 'gpt-4o',
  GPT_4_1_MINI = 'gpt-4.1-mini',
  GPT_5_1 = 'gpt-5.1',
  GPT_5_1_CHAT = 'gpt-5.1-chat',
  GPT_5_NANO = 'gpt-5-nano',
  GPT_4_1_NANO = 'gpt-4.1-nano',
  GPT_4O_MINI = 'gpt-4o-mini',
  GPT_o4_MINI = 'o4-mini',
  GPT_o3_MINI = 'o3-mini',
  GPT_5_5 = 'gpt-5.5',
  // The GPT 5.6 trio: a NEW capability hierarchy (Sol flagship → Terra
  // balanced → Luna light) replacing the standard/mini/nano size axis; its
  // own picker family ('gpt-56') with Sol/Terra/Luna as variants.
  GPT_5_6_SOL = 'gpt-5.6-sol',
  GPT_5_6_TERRA = 'gpt-5.6-terra',
  GPT_5_6_LUNA = 'gpt-5.6-luna',
  // Rolling alias Azure names as the replacement for retired gpt-*-chat
  // model versions; the deployment is upgraded in place as new chat models ship.
  GPT_CHAT_LATEST = 'gpt-chat-latest',
  // Anthropic Claude models (via Azure AI Foundry)
  CLAUDE_OPUS_4_6 = 'claude-opus-4-6',
  CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6',
  CLAUDE_OPUS_4_1 = 'claude-opus-4-1',
  CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5',
  CLAUDE_OPUS_4_8 = 'claude-opus-4-8',
  CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5',
  CLAUDE_FABLE_5 = 'claude-fable-5',
  CLAUDE_SONNET_5 = 'claude-sonnet-5',
  CLAUDE_OPUS_4_7 = 'claude-opus-4-7',
  CLAUDE_OPUS_4_5 = 'claude-opus-4-5',
  // Other providers
  KIMI_K2_6 = 'Kimi-K2.6',
  LLAMA_4_MAVERICK = 'Llama-4-Maverick-17B-128E-Instruct-FP8',
  LLAMA_4_SCOUT = 'Llama-4-Scout-17B-16E-Instruct',
  LLAMA_3_3_70B = 'Llama-3.3-70B-Instruct',
  DEEPSEEK_R1 = 'DeepSeek-R1',
  DEEPSEEK_R1_0528 = 'DeepSeek-R1-0528',
  DEEPSEEK_V3_1 = 'DeepSeek-V3.1',
  DEEPSEEK_V3_2 = 'DeepSeek-V3.2',
  DEEPSEEK_V4_PRO = 'DeepSeek-V4-Pro',
  DEEPSEEK_V4_FLASH = 'DeepSeek-V4-Flash',
  MISTRAL_LARGE_3 = 'Mistral-Large-3',
  MISTRAL_MEDIUM_3_5 = 'mistral-medium-3-5',
  MISTRAL_MEDIUM_2505 = 'mistral-medium-2505',
  MISTRAL_SMALL_2503 = 'mistral-small-2503',
  MINISTRAL_3B = 'Ministral-3B',
  GROK_3 = 'grok-3',
  GROK_4 = 'grok-4',
  GROK_3_MINI = 'grok-3-mini',
  GROK_4_1_FAST_REASONING = 'grok-4-1-fast-reasoning',
  GROK_4_1_FAST_NON_REASONING = 'grok-4-1-fast-non-reasoning',
}

// OpenAIVisionModelID is derived from the `supportsVision` metadata flag at the
// bottom of this file (after OpenAIModels is built), so vision support has a
// single source of truth in config/models.json and discovered models can opt in
// via metadata without editing an enum here.

// Last-resort fallback model id, used when no default can be resolved. Must
// be a standard-variant GPT that is enabled in EVERY ring (the dynamic
// default in config/models.ts getDefaultModel() is preferred everywhere a
// ring-aware answer is possible).
export const fallbackModelID = OpenAIModelID.GPT_5_2;

/**
 * Default display order for models in the model selection UI.
 * Used when no user preferences exist.
 * This array defines the priority order - models listed first appear at the top.
 */
export const DEFAULT_MODEL_ORDER: OpenAIModelID[] = [
  // The picker list is NOT grouped by provider, so this order is the layout:
  // flagships first with cross-provider variety near the top. A FAMILY row
  // anchors at its first member listed here (first VISIBLE member after the
  // ring gate — hence the extra prod-anchor entries below).
  OpenAIModelID.GPT_5_2, // "GPT" family row
  OpenAIModelID.GPT_5_2_CHAT, // "GPT Chat" family row
  OpenAIModelID.GPT_5_6_SOL, // "GPT 5.6" family row (Sol → Terra → Luna)
  OpenAIModelID.CLAUDE_OPUS_4_8, // "Claude" family row…
  OpenAIModelID.CLAUDE_SONNET_4_6, // …prod anchor + prod face (4.8/5 ring-gated there)
  OpenAIModelID.CLAUDE_FABLE_5, // standalone row
  OpenAIModelID.MISTRAL_LARGE_3, // "Mistral" family row
  OpenAIModelID.DEEPSEEK_V3_2, // "DeepSeek" family row (Standard variant leads)…
  OpenAIModelID.DEEPSEEK_R1, // …prod anchor (V3.2 ring-gated there)
  OpenAIModelID.GPT_o3, // "o-series" family row
  OpenAIModelID.LLAMA_4_MAVERICK, // "Llama" family row
  OpenAIModelID.KIMI_K2_6, // "Kimi" family row
  // Non-representative family members: they surface as variant segments and
  // version chips in the details panel rather than list rows, so position
  // below only breaks ties (usage mode, equal versionRank) and orders the
  // flattened edit-order list.
  OpenAIModelID.GPT_5_6_TERRA,
  OpenAIModelID.GPT_5_6_LUNA,
  OpenAIModelID.GPT_5_5,
  OpenAIModelID.GPT_5_4,
  OpenAIModelID.GPT_4_1,
  OpenAIModelID.GPT_5_1,
  OpenAIModelID.GPT_5,
  OpenAIModelID.GPT_4O,
  OpenAIModelID.GPT_5_MINI,
  OpenAIModelID.GPT_4_1_MINI,
  OpenAIModelID.GPT_4O_MINI,
  OpenAIModelID.GPT_5_4_NANO,
  OpenAIModelID.GPT_5_NANO,
  OpenAIModelID.GPT_4_1_NANO,
  OpenAIModelID.GPT_CHAT_LATEST,
  OpenAIModelID.GPT_5_3_CHAT,
  OpenAIModelID.GPT_5_1_CHAT,
  OpenAIModelID.GPT_5_CHAT,
  OpenAIModelID.GPT_o4_MINI,
  OpenAIModelID.GPT_o3_MINI,
  OpenAIModelID.CLAUDE_SONNET_5,
  OpenAIModelID.CLAUDE_OPUS_4_7,
  OpenAIModelID.CLAUDE_OPUS_4_6,
  OpenAIModelID.CLAUDE_HAIKU_4_5,
  OpenAIModelID.CLAUDE_SONNET_4_5,
  OpenAIModelID.CLAUDE_OPUS_4_5,
  OpenAIModelID.CLAUDE_OPUS_4_1,
  OpenAIModelID.DEEPSEEK_V4_PRO,
  OpenAIModelID.DEEPSEEK_V4_FLASH,
  OpenAIModelID.DEEPSEEK_R1_0528,
  OpenAIModelID.DEEPSEEK_V3_1,
  OpenAIModelID.MISTRAL_MEDIUM_3_5,
  OpenAIModelID.MISTRAL_MEDIUM_2505,
  OpenAIModelID.MISTRAL_SMALL_2503,
  OpenAIModelID.MINISTRAL_3B,
  OpenAIModelID.LLAMA_4_SCOUT,
  OpenAIModelID.LLAMA_3_3_70B,
  // Globally disabled models (grok-*), kept for edit-order completeness.
  OpenAIModelID.GROK_4,
  OpenAIModelID.GROK_4_1_FAST_REASONING,
  OpenAIModelID.GROK_4_1_FAST_NON_REASONING,
  OpenAIModelID.GROK_3,
  OpenAIModelID.GROK_3_MINI,
];

/**
 * Zod schema mirroring OpenAIModel's important fields. Used to validate
 * config/models.json at module load so a malformed edit (e.g. modelType:'Omni',
 * sdk:'azure_openai', supportsVision:'true') fails fast with a clear error
 * instead of being silently cast through `as unknown as` and surfacing as
 * broken routing/UI at runtime. Optional fields stay optional; unknown extra
 * keys are stripped rather than rejected so adding a new field to the JSON
 * ahead of the type doesn't hard-fail.
 */
const openAIModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  maxLength: z.number(),
  tokenLimit: z.number(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
  modelType: z.enum(['foundational', 'omni', 'reasoning', 'agent']).optional(),
  description: z.string().optional(),
  tagline: z.string().optional(),
  isRecommended: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
  isAgent: z.boolean().optional(),
  isCustomAgent: z.boolean().optional(),
  isOrganizationAgent: z.boolean().optional(),
  agentId: z.string().optional(),
  agentVersion: z.string().optional(),
  foundryEndpoint: z.string().optional(),
  agentSource: z.string().optional(),
  provider: z
    .enum([
      'openai',
      'deepseek',
      'xai',
      'meta',
      'anthropic',
      'mistral',
      'moonshot',
    ])
    .optional(),
  knowledgeCutoffDate: z.string().optional(),
  sdk: z.enum(['azure-openai', 'openai', 'anthropic-foundry']).optional(),
  supportsTemperature: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  deploymentName: z.string().optional(),
  modelSource: z.string().optional(),
  isCustomSourceModel: z.boolean().optional(),
  // hostedIn, sourceLocation, and deploymentModelVersion are intentionally NOT
  // in this schema: they are derived at runtime (live discovery / the byom
  // sources route), never authored in config/models.json (unknown keys are
  // stripped, so an accidental JSON entry is discarded rather than trusted).
  hosting: z.enum(['azure', 'external']).optional(),
  tier: z.enum(['featured', 'standard', 'legacy']).optional(),
  lifecycle: z
    .enum(['preview', 'ga', 'legacy', 'deprecated', 'retired'])
    .optional(),
  retirementDate: z.string().optional(),
  retirementReplacement: z.string().optional(),
  sizeClass: z.enum(['nano', 'mini', 'standard', 'large']).optional(),
  series: z.string().optional(),
  seriesLabel: z.string().optional(),
  versionLabel: z.string().optional(),
  variant: z.string().optional(),
  variantLabel: z.string().optional(),
  variantRank: z.number().optional(),
  defaultRank: z.number().optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  supportsReasoningEffort: z.boolean().optional(),
  supportsMinimalReasoning: z.boolean().optional(),
  verbosity: z.enum(['low', 'medium', 'high']).optional(),
  supportsVerbosity: z.boolean().optional(),
  avoidSystemPrompt: z.boolean().optional(),
  usesResponsesAPI: z.boolean().optional(),
});

/**
 * Per-model baseline metadata, loaded from config/models.json. This is the
 * source of truth for KNOWN models' presentation + routing (display name,
 * context window, sdk, capability/tool flags, agentId). Azure discovery does
 * not return any of this — see docs/MODEL_DISCOVERY_DESIGN.md.
 *
 * Validated at load (instead of an unchecked `as unknown as` cast) so the
 * JSON's enum/union/flag fields are guaranteed well-formed. The runtime check
 * in createModelConfigs() additionally guarantees every OpenAIModelID has an
 * entry.
 */
const MODEL_METADATA: Record<string, OpenAIModel> = (() => {
  const parsed = z
    .record(z.string(), openAIModelSchema)
    .safeParse(modelMetadata.models);
  if (!parsed.success) {
    throw new Error(
      `[openai] Invalid config/models.json metadata: ${parsed.error.message}`,
    );
  }
  return parsed.data as Record<string, OpenAIModel>;
})();

/**
 * Builds the model configuration map from config/models.json, keyed by
 * OpenAIModelID. Throws at module load if any known model id is missing its
 * metadata entry, so a bad edit fails fast rather than surfacing as an
 * undefined model at runtime.
 */
function createModelConfigs(): Record<OpenAIModelID, OpenAIModel> {
  const configs = {} as Record<OpenAIModelID, OpenAIModel>;
  const knownIds = new Set<string>(Object.values(OpenAIModelID));
  for (const id of Object.values(OpenAIModelID)) {
    const meta = MODEL_METADATA[id];
    if (!meta) {
      throw new Error(
        `[openai] Missing metadata for model "${id}" in config/models.json`,
      );
    }
    configs[id] = meta;
  }
  // Reverse direction: surface stale/orphaned metadata. A models.json key with
  // no matching OpenAIModelID is never used (configs is keyed by enum), which
  // usually means a typo or a model removed from the enum but not the JSON.
  for (const key of Object.keys(MODEL_METADATA)) {
    if (!knownIds.has(key)) {
      console.warn(
        `[openai] config/models.json has metadata for unknown model id "${key}" (not in OpenAIModelID); it will be ignored.`,
      );
    }
  }
  return configs;
}

export const OpenAIModels: Record<OpenAIModelID, OpenAIModel> =
  createModelConfigs();

/**
 * Hosting with its default applied. The single defaulting point: static-list
 * models and synthesized unknowns (both of which omit the field) resolve to
 * 'azure' here instead of every consumer re-implementing the fallback.
 */
export function getModelHosting(
  model: Pick<OpenAIModel, 'hosting'>,
): NonNullable<OpenAIModel['hosting']> {
  return model.hosting ?? 'azure';
}

/** Curation tier with its default applied (see getModelHosting). */
export function getModelTier(
  model: Pick<OpenAIModel, 'tier'>,
): NonNullable<OpenAIModel['tier']> {
  return model.tier ?? 'standard';
}

/** Emissions size class with its default applied (see getModelHosting). */
export function getModelSizeClass(
  model: Pick<OpenAIModel, 'sizeClass'>,
): NonNullable<OpenAIModel['sizeClass']> {
  return model.sizeClass ?? 'standard';
}

/**
 * Provenance of the model list served by /api/models, stored client-side so
 * the UI can adapt (suppress region/hosting chrome on static lists, note
 * partial results). Defined here rather than in the route file so client code
 * never imports from a server route module.
 *  - 'static'            — client-side static seed, before /api/models responds.
 *  - 'static-no-region'  — no regional accounts configured; static list served.
 *  - 'discovery'         — all applicable regions discovered.
 *  - 'discovery-partial' — home region discovered; a foreign region failed.
 *  - 'fallback'          — discovery errored server-side; static list.
 */
export type ModelListSource =
  | 'static'
  | 'static-no-region'
  | 'discovery'
  | 'discovery-partial'
  | 'fallback';

/**
 * Vision-capable model IDs, derived from the `supportsVision` metadata flag.
 *
 * Previously a hand-maintained enum; now built from config/models.json so vision
 * support has a single source of truth and discovered models can declare it via
 * metadata. Shape is a `{ id: id }` map (not an enum) so existing consumers that
 * call `Object.values(OpenAIVisionModelID)` or pass it to `checkIsModelValid`
 * keep working unchanged.
 */
export const OpenAIVisionModelID: Record<string, string> = Object.fromEntries(
  Object.values(OpenAIModels)
    .filter((model) => model.supportsVision)
    .map((model) => [model.id, model.id]),
);
// `OpenAIVisionModelID` is intentionally BOTH a value and a type under one name:
//   - the value (above) is the runtime `{ id: id }` map of vision-capable models,
//     derived from metadata so consumers can enumerate it at runtime.
//   - the type (below) is intentionally widened to `string` rather than a union
//     of those ids. The set is data-driven (discovered models can opt in via
//     metadata), so a narrow union would be wrong/stale; widening to `string`
//     keeps existing `as OpenAIVisionModelID` casts compiling without implying a
//     closed set. They share a name so those casts keep reading naturally.
// TypeScript allows a value and a type to share a name; the base ESLint
// no-redeclare rule doesn't model that, so it's disabled for this line only.
// eslint-disable-next-line no-redeclare
export type OpenAIVisionModelID = string;
