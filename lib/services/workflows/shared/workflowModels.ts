import { DEFAULT_ANALYSIS_MODEL } from '@/lib/utils/app/const';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

/**
 * Which models can run workflow LLM operations. Leaf module (no server
 * imports) so both the workflow API routes and the client-side model
 * picker share one definition — the picker must never offer a model the
 * server would silently swap out.
 *
 * Workflow routes call Azure OpenAI chat completions directly, so only
 * Azure-OpenAI-served base models qualify: agents and other providers
 * (anthropic, mistral…) are out.
 */
export function isWorkflowEligibleModel(model: {
  provider?: string;
  isCustomAgent?: boolean;
  isOrganizationAgent?: boolean;
  isDisabled?: boolean;
}): boolean {
  if (model.provider && model.provider !== 'openai') return false;
  if (model.isCustomAgent || model.isOrganizationAgent) return false;
  if (model.isDisabled) return false;
  return true;
}

/**
 * Resolves a client-requested model id for a workflow LLM call, falling
 * back to the default for unknown/ineligible ids — a stale persisted
 * model id can never break a workflow.
 */
export function resolveWorkflowModelId(modelId?: string): string {
  if (!modelId) return DEFAULT_ANALYSIS_MODEL;
  const model = OpenAIModels[modelId as OpenAIModelID];
  if (!model) return DEFAULT_ANALYSIS_MODEL;
  return isWorkflowEligibleModel(model) ? model.id : DEFAULT_ANALYSIS_MODEL;
}

/**
 * Like resolveWorkflowModelId, but for multimodal calls (photo
 * extraction): the resolved model must be vision-capable, else fall back
 * to the default analysis model (which is — verified in config).
 */
export function resolveVisionWorkflowModelId(modelId?: string): string {
  const resolved = resolveWorkflowModelId(modelId);
  const model = OpenAIModels[resolved as OpenAIModelID];
  return model?.supportsVision ? resolved : DEFAULT_ANALYSIS_MODEL;
}
