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
  provider?: 'openai' | 'deepseek' | 'xai' | 'meta' | 'anthropic'; // Model provider
  knowledgeCutoffDate?: string; // ISO format for sorting and display (e.g., "2025-01" or "2025-01-20")
  sdk?: 'azure-openai' | 'openai' | 'anthropic-foundry'; // Which SDK this model requires
  supportsTemperature?: boolean; // Whether this model supports custom temperature values
  supportsVision?: boolean; // Whether this model can accept image input. Source of truth for OpenAIVisionModelID (derived below).
  deploymentName?: string; // Azure AI Foundry deployment name (for third-party models)

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
  // Anthropic Claude models (via Azure AI Foundry)
  CLAUDE_OPUS_4_6 = 'claude-opus-4-6',
  CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6',
  CLAUDE_OPUS_4_1 = 'claude-opus-4-1',
  CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5',
  // Other providers
  LLAMA_4_MAVERICK = 'Llama-4-Maverick-17B-128E-Instruct-FP8',
  DEEPSEEK_R1 = 'DeepSeek-R1',
  DEEPSEEK_V3_1 = 'DeepSeek-V3.1',
  GROK_3 = 'grok-3',
}

// OpenAIVisionModelID is derived from the `supportsVision` metadata flag at the
// bottom of this file (after OpenAIModels is built), so vision support has a
// single source of truth in config/models.json and discovered models can opt in
// via metadata without editing an enum here.

// Fallback model ID
export const fallbackModelID = OpenAIModelID.GPT_5_2_CHAT;

/**
 * Default display order for models in the model selection UI.
 * Used when no user preferences exist.
 * This array defines the priority order - models listed first appear at the top.
 */
export const DEFAULT_MODEL_ORDER: OpenAIModelID[] = [
  OpenAIModelID.GPT_5_2,
  OpenAIModelID.GPT_5_2_CHAT,
  OpenAIModelID.GPT_o3,
  OpenAIModelID.GPT_5_MINI,
  OpenAIModelID.GPT_4_1,
  OpenAIModelID.CLAUDE_OPUS_4_6,
  OpenAIModelID.CLAUDE_SONNET_4_6,
  OpenAIModelID.CLAUDE_OPUS_4_1,
  OpenAIModelID.CLAUDE_HAIKU_4_5,
  OpenAIModelID.LLAMA_4_MAVERICK,
  OpenAIModelID.DEEPSEEK_R1,
  OpenAIModelID.DEEPSEEK_V3_1,
  OpenAIModelID.GROK_3,
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
    .enum(['openai', 'deepseek', 'xai', 'meta', 'anthropic'])
    .optional(),
  knowledgeCutoffDate: z.string().optional(),
  sdk: z.enum(['azure-openai', 'openai', 'anthropic-foundry']).optional(),
  supportsTemperature: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  deploymentName: z.string().optional(),
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
