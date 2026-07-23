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
 * Best-effort by design: any failure (timeout, schema mismatch, hallucinated
 * tool names) returns null and the loop runs plan-less, exactly as before
 * this feature existed.
 */

const PLANNER_MODEL = 'gpt-5-mini';
const PLANNER_BUDGET_MS = 8_000;
/** Description snippets keep the planner prompt small on big catalogs. */
const MAX_TOOL_DESCRIPTION_CHARS = 120;

export async function planMcpSteps(
  client: OpenAI,
  userMessage: string,
  serversWithTools: ServerWithTools[],
): Promise<McpPlanStep[] | null> {
  const catalog = serversWithTools
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
  if (!catalog) return null;

  const knownToolNames = new Set(
    serversWithTools.flatMap(({ tools }) => tools.map((tool) => tool.name)),
  );

  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('Planner budget exceeded')),
        PLANNER_BUDGET_MS,
      );
    });
    const response = await Promise.race([
      client.chat.completions.create({
        model: PLANNER_MODEL,
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
      }),
      timeout,
    ]);

    const parsed = JSON.parse(
      response.choices[0]?.message?.content || '{}',
    ) as { steps?: Array<{ description?: string; tools?: string[] }> };

    const steps: McpPlanStep[] = (parsed.steps ?? [])
      .filter(
        (step) =>
          typeof step.description === 'string' && step.description.trim(),
      )
      .map((step) => ({
        description: step
          .description!.trim()
          .slice(0, MAX_PLAN_STEP_DESCRIPTION_CHARS),
        // Hallucinated tool names are dropped, not dispatched.
        tools: (step.tools ?? []).filter((tool) => knownToolNames.has(tool)),
      }))
      .slice(0, MAX_PLAN_STEPS);

    return steps.length > 0 ? steps : null;
  } catch (error) {
    console.warn(
      '[McpPlannerService] Planning failed; running the loop plan-less:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
