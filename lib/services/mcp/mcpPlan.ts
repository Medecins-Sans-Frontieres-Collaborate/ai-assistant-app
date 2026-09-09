import {
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_DESCRIPTION_CHARS,
  MAX_PLAN_STEP_TOOLS,
  McpPlan,
  McpPlanStep,
} from '@/types/mcp';

/**
 * Pure helpers for the MCP turn plan: system-prompt rendering, tool→step
 * advancement, empty-result classification, and defensive sanitization of
 * client-echoed plans. Kept free of I/O so every behavior is unit-testable.
 */

/**
 * Renders the plan into the tool loop's system addendum. Rebuilt on EVERY
 * request (each request is one loop round in the stateless protocol), so it
 * carries live progress: which steps are done, which is current, and — on
 * the final step — that completing it ends tool use and produces the
 * answer. That last part is what makes the plan a hard scope instead of a
 * suggestion the loop drifts past.
 */
export function buildPlanSystemAddendum(plan: McpPlan): string {
  const total = plan.steps.length;
  const steps = plan.steps
    .map((step, idx) => {
      const marker =
        idx < plan.currentStep
          ? '[done]'
          : idx === plan.currentStep
            ? '[CURRENT]'
            : '[pending]';
      return `${idx + 1}. ${marker} ${step.description}${
        step.tools.length ? ` (tools: ${step.tools.join(', ')})` : ''
      }`;
    })
    .join('\n');

  const finalStepDirective =
    plan.currentStep >= total - 1
      ? `\n- You are on the FINAL step. Complete it, then STOP calling tools and write the complete answer to the user. Do not add steps.`
      : '';

  return `## Tool Plan for This Turn (step ${plan.currentStep + 1} of ${total})

You are executing a fixed plan. Work ONLY on the current step; results of one step determine how many calls the next needs.
${steps}

- Make the FEWEST, most targeted tool calls that satisfy the current step; batch independent calls in one round.
- If a tool returns nothing useful, you may retry it ONCE with adjusted arguments, then move on without it.
- When the last step is complete, stop calling tools and answer — the plan is the full scope of this turn.
- Deviate only if a step proves impossible or unnecessary — and say so briefly when you do.${finalStepDirective}`;
}

/**
 * Maps an executed tool call onto the plan: the earliest step at or after
 * `currentStep` that recommends this tool. Advancement is monotonic — the
 * loader never walks backwards. Returns null when no step lists the tool
 * (the loader falls back to the plain tool-name activity).
 */
export function stepIndexForTool(
  plan: McpPlan,
  toolName: string,
): number | null {
  for (let i = plan.currentStep; i < plan.steps.length; i++) {
    if (plan.steps[i].tools.includes(toolName)) return i;
  }
  // A tool from an EARLIER step (the model looped back): keep the current
  // step rather than rewinding the display.
  for (let i = 0; i < plan.currentStep; i++) {
    if (plan.steps[i].tools.includes(toolName)) return plan.currentStep;
  }
  return null;
}

/**
 * Conservative "this returned nothing" classifier for the one-retry
 * mechanic. Only shapes that are unambiguously empty count — a legitimate
 * "no PRs assigned to you" answer must never trigger retry nagging.
 */
export function isEmptyToolResult(text: string, isError: boolean): boolean {
  if (isError) return true;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '(empty result)') return true;
  if (/^\[\s*\]$/.test(trimmed) || /^\{\s*\}$/.test(trimmed)) return true;
  // Single-collection JSON bodies with an empty array: {"items": []} etc.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = Object.values(parsed);
      if (
        values.length > 0 &&
        values.every((v) => Array.isArray(v) && v.length === 0)
      ) {
        return true;
      }
    }
  } catch {
    // Not JSON — non-empty text is a real result.
  }
  return false;
}

/**
 * Appended to an empty/failed tool result so the model retries ONCE with
 * adjusted arguments instead of improvising or repeating identical args.
 */
export const RETRY_NUDGE =
  '\n\n[System note: this tool returned nothing useful. You may retry it ONCE with adjusted arguments (broader terms, corrected identifiers); if it still returns nothing, move on without it.]';

/**
 * Defensive normalization of a client-echoed plan (it round-trips through
 * the browser across approval pauses). Returns null when nothing usable
 * survives — the loop then simply runs plan-less.
 */
export function sanitizeMcpPlan(value: unknown): McpPlan | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { steps?: unknown; currentStep?: unknown };
  if (!Array.isArray(raw.steps)) return null;

  const steps: McpPlanStep[] = [];
  for (const step of raw.steps.slice(0, MAX_PLAN_STEPS)) {
    if (!step || typeof step !== 'object') continue;
    const s = step as {
      description?: unknown;
      tools?: unknown;
      retried?: unknown;
    };
    if (typeof s.description !== 'string' || !s.description.trim()) continue;
    const tools = Array.isArray(s.tools)
      ? s.tools
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
          .slice(0, MAX_PLAN_STEP_TOOLS)
      : [];
    steps.push({
      description: s.description
        .trim()
        .slice(0, MAX_PLAN_STEP_DESCRIPTION_CHARS),
      tools,
      ...(s.retried === true ? { retried: true } : {}),
    });
  }
  if (steps.length === 0) return null;

  const currentStep =
    typeof raw.currentStep === 'number' &&
    Number.isInteger(raw.currentStep) &&
    raw.currentStep >= 0
      ? Math.min(raw.currentStep, steps.length - 1)
      : 0;

  return { steps, currentStep };
}
