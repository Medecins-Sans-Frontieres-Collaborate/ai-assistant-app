import type { OpenAIModel } from '@/types/openai';

/** Reasoning effort levels the application exposes to users. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Resolve the reasoning effort a model deployment can actually accept.
 *
 * The user-facing setting is shared across models, but provider support is
 * not: GPT-5.6 and later reject `reasoning_effort: 'minimal'` outright with
 * HTTP 400 ("Unsupported value ... Supported values are: 'none', 'low',
 * 'medium', 'high', and 'xhigh'"), while GPT-5 through GPT-5.4 accept it.
 * Every request builder that forwards the setting must go through this
 * helper so a single capability flag in `config/models.json` governs all of
 * them (chat completions, Responses API, auxiliary routing).
 *
 * @param modelConfig Capability flags for the serving model; `undefined`
 *   when the model is unknown, which disables the parameter entirely.
 * @param requested The effort the caller asked for.
 * @returns The effort to send, or `undefined` when the model does not take
 *   the parameter at all. An unsupported `'minimal'` degrades to `'low'`,
 *   the nearest level every reasoning model accepts.
 */
export function resolveReasoningEffort(
  modelConfig:
    | Pick<OpenAIModel, 'supportsReasoningEffort' | 'supportsMinimalReasoning'>
    | undefined,
  requested: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!modelConfig?.supportsReasoningEffort || !requested) return undefined;
  if (requested === 'minimal' && !modelConfig.supportsMinimalReasoning)
    return 'low';
  return requested;
}
