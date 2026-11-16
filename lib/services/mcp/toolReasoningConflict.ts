/**
 * Some reasoning models accept function tools on chat.completions only when
 * reasoning is switched off. GPT-5.6 Luna answers such a request with
 *
 *   400 Function tools with reasoning_effort are not supported for
 *   gpt-5.6-luna in /v1/chat/completions. To use function tools, use
 *   /v1/responses or set reasoning_effort to 'none'.
 *
 * which made every connector turn on that model fail (browser run
 * 2026-11-14, Microsoft 365 tools on). The provider names its own remedy, so
 * the tool loop applies it instead of keeping a per-model list that would
 * have to be guessed at for each new deployment.
 */

/** The effort value the provider asks for when tools and reasoning clash. */
export const REASONING_EFFORT_WITH_TOOLS = 'none';

/**
 * Whether an error is the provider refusing function tools because a
 * reasoning effort was sent with them.
 *
 * @param error - Whatever the model call threw.
 * @returns True only for an HTTP 400 whose message names both the
 *   `reasoning_effort` parameter and tools; any other failure is false and
 *   must be handled as before.
 */
export function isToolReasoningConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, message } = error as { status?: unknown; message?: unknown };
  if (status !== 400 || typeof message !== 'string') return false;
  return /reasoning_effort/i.test(message) && /\btools?\b/i.test(message);
}
