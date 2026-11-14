import {
  getAuxiliaryCompletions,
  parseJsonReply,
} from '@/lib/services/auxiliary/auxiliaryCompletion';
import type { AuxiliaryRegion } from '@/lib/services/auxiliary/types';
import type { StructuredDecisionFallback } from '@/lib/services/chat/routing/structuredDecisionFallback';

import type { AuxiliaryUsageSink } from '@/types/chat';
import {
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_DESCRIPTION_CHARS,
  McpPlanStep,
} from '@/types/mcp';

import { ServerWithTools } from './toolLoopCore';

import type OpenAI from 'openai';

/**
 * Plans a native-MCP turn before the tool loop runs: 1-5 sequential steps
 * with recommended tools. The plan gives the loop a spine — without it,
 * each round improvises against the full tool catalog and quality varies
 * wildly turn to turn.
 *
 * Best-effort by design: any failure (no residency-eligible model, timeout,
 * schema mismatch, only hallucinated tool names) returns null and the loop
 * runs plan-less, exactly as before this feature existed.
 */

const PLANNER_BUDGET_MS = 8_000;
/** Description snippets keep the planner prompt small on big catalogs. */
const MAX_TOOL_DESCRIPTION_CHARS = 120;

/** Where a plan may be made for this turn. */
export interface McpPlannerRouting {
  /** Residency region for the auxiliary chain (auxiliaryRegion()). */
  region: AuxiliaryRegion;
  /** The user's chat model, when it can serve a structured call. */
  fallback?: StructuredDecisionFallback;
  /** Token-usage sink for the planning call. */
  onUsage?: AuxiliaryUsageSink;
  /** Cancels planning (client disconnect). */
  signal?: AbortSignal;
}

/** Formats the connector catalog for the planner prompt; '' when empty. */
function plannerCatalog(serversWithTools: ServerWithTools[]): string {
  return serversWithTools
    .filter(({ tools }) => tools.length > 0)
    .map(({ server, tools }) => {
      const toolLines = tools
        .map(
          (tool) =>
            `- ${tool.name}${
              tool.description
                ? `: ${tool.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS)}`
                : ''
            }`,
        )
        .join('\n');
      return `Connector "${server.label}":\n${toolLines}`;
    })
    .join('\n\n');
}

/**
 * The planning request. Exported so the auxiliary readiness probe
 * (auxiliary/probes.ts) exercises exactly what runtime sends.
 *
 * @param userMessage - The user's request text.
 * @param catalog - The formatted tool catalog.
 */
export function mcpPlanRequest(
  userMessage: string,
  catalog: string,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    model: '',
    // 'low' (not minimal): decomposition quality is the whole point —
    // minimal effort collapses multi-part requests into one lazy step.
    reasoning_effort: 'low',
    max_completion_tokens: 700,
    messages: [
      {
        role: 'system',
        content:
          `You plan how an AI assistant should use external tools to fulfill a request. The plan is a HARD SCOPE: the assistant works through it step by step and, when the last step completes, stops calling tools and answers — so the plan must cover everything the request needs, and nothing it doesn't.\n` +
          `Produce 2-${MAX_PLAN_STEPS - 1} milestone steps for any multi-part request; exactly 1 step ONLY when a single tool call fully answers it.\n` +
          `For each step give:\n` +
          `- description: one short imperative sentence, written in the SAME LANGUAGE as the user's request (it is shown to the user as live progress)\n` +
          `- tools: 1-4 EXACT tool names from the catalog for the step\n` +
          `Rules:\n` +
          `- A step is a milestone that may span several related calls (e.g. "for each org found, search its open PRs") — the results of one step size the next.\n` +
          `- Minimize total tool calls: pick the MOST DIRECT tool for each step (targeted search/filter tools over broad listing), never fetch data the request doesn't need.\n` +
          `- Never invent tool names; no setup/cleanup filler steps.`,
      },
      {
        role: 'user',
        content: `Request:\n${userMessage.slice(0, 4000)}\n\nAvailable tools:\n${catalog}`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'mcp_turn_plan',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } },
                },
                required: ['description', 'tools'],
                additionalProperties: false,
              },
            },
          },
          required: ['steps'],
          additionalProperties: false,
        },
      },
    },
  };
}

/**
 * Turns a planner reply into plan steps: blank steps dropped, hallucinated
 * tool names dropped, capped at MAX_PLAN_STEPS. Undefined (rejects the
 * reply) when nothing usable remains.
 */
function acceptPlan(
  response: OpenAI.Chat.Completions.ChatCompletion,
  knownToolNames: ReadonlySet<string>,
): McpPlanStep[] | undefined {
  const parsed = parseJsonReply(response) as
    | { steps?: Array<{ description?: unknown; tools?: unknown }> }
    | undefined;
  if (!parsed || !Array.isArray(parsed.steps)) return undefined;
  const steps: McpPlanStep[] = parsed.steps
    .filter(
      (step): step is { description: string; tools?: unknown } =>
        typeof step?.description === 'string' && !!step.description.trim(),
    )
    .map((step) => ({
      description: step.description
        .trim()
        .slice(0, MAX_PLAN_STEP_DESCRIPTION_CHARS),
      // Hallucinated tool names are dropped, not dispatched.
      tools: (Array.isArray(step.tools) ? step.tools : []).filter(
        (tool): tool is string =>
          typeof tool === 'string' && knownToolNames.has(tool),
      ),
    }))
    .slice(0, MAX_PLAN_STEPS);
  return steps.length > 0 ? steps : undefined;
}

/**
 * Plans the turn through the shared helper-model path (operation
 * `mcpPlan`) in the user's residency region, with the user's chat model as
 * the fallback when supplied.
 *
 * @param userMessage - The user's request text.
 * @param serversWithTools - The connectors and their tools.
 * @param routing - Residency region, fallback, usage sink, cancellation.
 * @returns The plan, or null on any failure (never throws).
 */
export async function planMcpSteps(
  userMessage: string,
  serversWithTools: ServerWithTools[],
  routing: McpPlannerRouting,
): Promise<McpPlanStep[] | null> {
  const catalog = plannerCatalog(serversWithTools);
  if (!catalog) return null;

  const knownToolNames = new Set(
    serversWithTools.flatMap(({ tools }) => tools.map((tool) => tool.name)),
  );

  try {
    const completions = await getAuxiliaryCompletions();
    const answer = await completions.completeJson({
      operation: 'mcpPlan',
      region: routing.region,
      params: mcpPlanRequest(userMessage, catalog),
      accept: (response) => acceptPlan(response, knownToolNames),
      timeoutMs: PLANNER_BUDGET_MS,
      signal: routing.signal,
      onUsage: routing.onUsage,
      fallback: routing.fallback,
    });
    return answer.value;
  } catch (error) {
    console.warn(
      '[McpPlannerService] Planning failed; running the loop plan-less:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
