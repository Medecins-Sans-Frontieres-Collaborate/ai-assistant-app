import type { M365BuiltinExecutor } from '@/lib/services/m365/tools/executor';

import {
  StreamMetadata,
  TokenUsageMetadata,
  appendMetadataToStream,
} from '@/lib/utils/app/metadata';

import { ApprovalResponse } from '@/types/chat';
import { McpPendingToolCall, McpPlan, McpPlanStep } from '@/types/mcp';
import { Citation } from '@/types/rag';

import { connectMcp, isMcpAuthError } from './McpClientService';
import {
  deniedCallToOutcomeMarker,
  pendingCallToConsentMarker,
  toolResultToRecordMarker,
} from './mcpEventMappers';
import { DENIED_TOOL_RESULT } from './mcpEventMappers';
import {
  RETRY_NUDGE,
  buildPlanSystemAddendum,
  isEmptyToolResult,
  stepIndexForTool,
} from './mcpPlan';
import { buildConnectorInstructionsAddendum } from './mcpSystemContext';
import { AssembledToolCall } from './openaiToolCallAccumulator';
import { parseToolArguments, partitionApprovals } from './toolLoopReducer';
import { fromModelToolName } from './toolNameMapping';
import {
  McpToolDefinition,
  getCachedTools,
  setCachedTools,
  toolCacheKey,
} from './toolSchemaCache';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';
import { emitAgentActivity } from '@/lib/streamMarkers';

/**
 * Provider-agnostic core of the native MCP tool loop. One HTTP request runs
 * at most: one tool-execution batch (the resume path) plus one streamed model
 * round; a `tool_use` finish emits CONSENT_REQUEST markers and ENDS the
 * response (the server is stateless — approval arrives as a NEW request with
 * approvalResponses + mcpPendingToolCalls). Everything provider-specific —
 * tool declarations, transcript shapes, stream accumulation — lives in the
 * injected ToolLoopProviderStrategy; the correctness-critical orchestration
 * (one-result-per-pending-call, marker emission, round cap, usage
 * aggregation) lives here exactly once.
 */

export const MAX_TOOL_ROUNDS = 5;
const LIST_TOOLS_BUDGET_MS = 10_000;

export interface ServerWithTools {
  server: ResolvedMcpServer;
  tools: McpToolDefinition[];
  /** Server-declared usage guidance from the initialize handshake. */
  instructions?: string;
}

/** One pending call's outcome, fed back to the model by the strategy. */
export interface ExecutedToolResult {
  call: McpPendingToolCall;
  /** Result text, `Tool failed: …`, or DENIED_TOOL_RESULT. */
  text: string;
  /** True for genuine failures only — a user denial is not an error. */
  isError: boolean;
}

/** What one streamed model round produced. */
export interface AssembledRound {
  /** finish_reason 'tool_calls' (OpenAI) / stop_reason 'tool_use' (Anthropic). */
  finishedWithToolUse: boolean;
  calls: AssembledToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  /** Anthropic-only: accumulated thinking for the terminal metadata block. */
  thinking?: string;
}

export interface ToolLoopProviderStrategy<TMessage> {
  /**
   * Rebuild the transcript so the trailing assistant message carries the
   * pending tool calls (replace trailing assistant text / else append).
   */
  reconstructTranscript(
    messages: TMessage[],
    pending: McpPendingToolCall[],
  ): TMessage[];
  /**
   * Append ALL pending-call results (already in pending order). OpenAI: one
   * role:'tool' message per result. Anthropic: exactly ONE user message of
   * tool_result blocks — required for a legal transcript.
   */
  appendToolResults(
    messages: TMessage[],
    results: ExecutedToolResult[],
  ): TMessage[];
  /**
   * Build params (attaching tool declarations per `allowToolUse`), stream
   * the round, write() text deltas, and return what the round produced.
   */
  runModelRound(
    messages: TMessage[],
    serversWithTools: ServerWithTools[],
    allowToolUse: boolean,
    write: (text: string) => void,
  ): Promise<AssembledRound>;
  /**
   * Receive the connector-instructions addendum (trusted servers'
   * sanitized initialize `instructions`) to fold into every model round's
   * system prompt. Called once, after LIST_TOOLS, before any round.
   */
  applySystemAddendum?(addendum: string): void;
}

export interface ToolLoopCoreOptions<TMessage> {
  strategy: ToolLoopProviderStrategy<TMessage>;
  preparedMessages: TMessage[];
  servers: ResolvedMcpServer[];
  pendingToolCalls?: McpPendingToolCall[];
  approvalResponses?: ApprovalResponse[];
  loopRound: number;
  /**
   * Admin-configured cap from `feature.mcp.roundsPerRequest` (docs/LIMITS.md).
   * Absent → the compiled MAX_TOOL_ROUNDS, so behaviour is unchanged when
   * usage limits are disabled or unconfigured.
   */
  maxRounds?: number;
  userId: string;
  citations?: Citation[];
  usage: {
    modelId: string;
    region: 'US' | 'EU' | null;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    onUsage: (usage: TokenUsageMetadata) => void;
  };
  /**
   * Turn planner (first round only): given the user's request and the tool
   * catalog, returns 1-N steps or null (loop runs plan-less). Best-effort —
   * planner failures must never sink the turn.
   */
  planner?: (
    userMessage: string,
    serversWithTools: ServerWithTools[],
  ) => Promise<McpPlanStep[] | null>;
  /** Plan echoed back by the client on approval resume (already sanitized). */
  existingPlan?: McpPlan;
  /** Last user message text, for the planner. */
  userMessageText?: string;
  /**
   * In-process executor for `provenance: 'builtin'` servers (the M365
   * toolset). Listing and dispatch route here instead of an MCP connection;
   * a builtin server without an executor degrades to zero tools.
   */
  builtinExecutor?: M365BuiltinExecutor;
}

export async function listToolsForServers(
  servers: ResolvedMcpServer[],
  userId: string,
  builtinExecutor?: M365BuiltinExecutor,
): Promise<{ serversWithTools: ServerWithTools[]; failedLabels: string[] }> {
  const failedLabels: string[] = [];
  const results = await Promise.all(
    servers.map(async (server): Promise<ServerWithTools> => {
      if (server.provenance === 'builtin') {
        // Builtin servers list in-process: no connection, and no
        // toolSchemaCache entry — its (userId, url, authToken) key shape
        // never applies to a url-less synthetic server, and the executor
        // does its own consent-probe caching.
        if (!builtinExecutor) return { server, tools: [] };
        try {
          const tools = await withBudget(
            builtinExecutor.listTools(),
            LIST_TOOLS_BUDGET_MS,
          );
          return {
            server,
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
            instructions: builtinExecutor.instructions,
          };
        } catch {
          // Same degrade-don't-fail posture as network servers below.
          failedLabels.push(server.label);
          return { server, tools: [] };
        }
      }
      const cacheKey = toolCacheKey(userId, server.url, server.authToken);
      const cached = getCachedTools(cacheKey);
      if (cached)
        return {
          server,
          tools: cached.tools,
          instructions: cached.instructions,
        };
      try {
        const connection = await withBudget(
          connectMcp(server),
          LIST_TOOLS_BUDGET_MS,
        );
        try {
          const tools = await withBudget(
            connection.listTools(),
            LIST_TOOLS_BUDGET_MS,
          );
          const instructions = connection.getInstructions?.();
          setCachedTools(cacheKey, { tools, instructions });
          return { server, tools, instructions };
        } finally {
          await connection.close();
        }
      } catch {
        // A failing server degrades to zero tools; chat must never break
        // because one configured connector is down.
        failedLabels.push(server.label);
        return { server, tools: [] };
      }
    }),
  );
  return { serversWithTools: results, failedLabels };
}

export function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('MCP budget exceeded')), ms);
    }),
  ]);
}

export async function runToolLoopCore<TMessage>(
  options: ToolLoopCoreOptions<TMessage>,
): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const write = (text: string) => {
        if (text) controller.enqueue(encoder.encode(text));
      };
      const aggregate = { prompt: 0, completion: 0, total: 0 };

      try {
        // ── LIST_TOOLS (cache makes resume rounds cheap)
        write(emitAgentActivity('chat.activity.listingTools'));
        const { serversWithTools, failedLabels } = await listToolsForServers(
          options.servers,
          options.userId,
          options.builtinExecutor,
        );
        for (const label of failedLabels) {
          write(
            emitAgentActivity('chat.activity.usingNamedToolWithService', {
              tool: 'unavailable',
              service: label,
            }),
          );
        }
        const serverById = new Map(
          options.servers.map((server) => [server.id, server]),
        );

        // ── PLAN (first round only): decompose the request into steps with
        // recommended tools. Resumed rounds reuse the client-echoed plan.
        let turnPlan: McpPlan | null = options.existingPlan ?? null;
        if (
          !turnPlan &&
          options.planner &&
          options.userMessageText &&
          options.loopRound === 0 &&
          !options.pendingToolCalls?.length
        ) {
          write(emitAgentActivity('chat.activity.planningSteps'));
          try {
            const steps = await options.planner(
              options.userMessageText,
              serversWithTools,
            );
            if (steps && steps.length > 0) {
              turnPlan = { steps, currentStep: 0 };
            }
          } catch (error) {
            console.warn(
              '[toolLoopCore] Planner failed; continuing plan-less:',
              error instanceof Error ? error.message : error,
            );
          }
        }

        /**
         * Shows the plan step in the loader. Emits the retry variant when
         * the step already burned its empty-result retry (i.e. this
         * execution IS the retry).
         */
        const emitPlanStepActivity = (isRetry: boolean) => {
          if (!turnPlan) return;
          const step = turnPlan.steps[turnPlan.currentStep];
          if (!step) return;
          write(
            emitAgentActivity(
              isRetry
                ? 'chat.activity.planStepRetry'
                : 'chat.activity.planStep',
              {
                current: String(turnPlan.currentStep + 1),
                total: String(turnPlan.steps.length),
                description: step.description,
              },
            ),
          );
        };

        // Connector-provided usage notes → system prompt, with the trust
        // gate, sanitization, cap, and framing all in the builder. The plan
        // addendum rides the same single applySystemAddendum call.
        const instructionsAddendum = buildConnectorInstructionsAddendum(
          serversWithTools.map(({ server, instructions }) => ({
            label: server.label,
            trusted: server.trusted,
            instructions,
          })),
        );
        const combinedAddendum = [
          instructionsAddendum,
          turnPlan ? buildPlanSystemAddendum(turnPlan) : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        if (combinedAddendum) {
          options.strategy.applySystemAddendum?.(combinedAddendum);
        }

        // Show step 1 while the first model round streams.
        if (turnPlan && !options.pendingToolCalls?.length) {
          emitPlanStepActivity(false);
        }

        let messages = [...options.preparedMessages];

        // ── RESUME: execute the previous round's approved calls, in pending
        // order, producing exactly one result per pending call.
        if (options.pendingToolCalls?.length) {
          const pending = options.pendingToolCalls;
          const plan = partitionApprovals(pending, options.approvalResponses);
          const decisionById = new Map<string, 'approved' | 'denied'>();
          for (const call of plan.approved)
            decisionById.set(call.id, 'approved');
          for (const call of plan.denied) decisionById.set(call.id, 'denied');

          messages = options.strategy.reconstructTranscript(messages, pending);

          for (const call of plan.autoDenied) {
            write(deniedCallToOutcomeMarker(call.id));
          }

          const results: ExecutedToolResult[] = [];
          for (const call of pending) {
            if (decisionById.get(call.id) !== 'approved') {
              results.push({
                call,
                text: DENIED_TOOL_RESULT,
                isError: false,
              });
              continue;
            }

            const server = serverById.get(call.serverId);
            const args = parseToolArguments(call.argumentsJson);
            const startedAt = Date.now();
            if (!server || args === null) {
              const errorMessage = !server
                ? 'MCP server is no longer configured'
                : 'Tool arguments could not be parsed';
              write(
                toolResultToRecordMarker(
                  call,
                  server?.label ?? call.serverId,
                  { errorMessage },
                  0,
                ),
              );
              results.push({
                call,
                text: `Tool failed: ${errorMessage}`,
                isError: true,
              });
              continue;
            }

            // Plan-aware loader: map this call onto the plan and show the
            // step (or its retry). The plan is OVERARCHING — a tool no step
            // explicitly recommends still belongs to the current step, so
            // the numbered narrative never degrades back to bare tool
            // names mid-plan.
            let matchedStepIndex: number | null = null;
            if (turnPlan) {
              matchedStepIndex =
                stepIndexForTool(turnPlan, call.toolName) ??
                turnPlan.currentStep;
              const isRetry =
                matchedStepIndex === turnPlan.currentStep &&
                turnPlan.steps[matchedStepIndex].retried === true;
              turnPlan.currentStep = matchedStepIndex;
              emitPlanStepActivity(isRetry);
            } else {
              write(
                emitAgentActivity('chat.activity.usingNamedToolWithService', {
                  tool: call.toolName,
                  service: server.label,
                }),
              );
            }
            try {
              // Builtin dispatch: in-process execution, no connection to
              // open or close. The executor never throws (failures come
              // back as isError results), so the catch below only fires
              // for network servers or executor-contract violations.
              const connection =
                server.provenance === 'builtin' && options.builtinExecutor
                  ? null
                  : await connectMcp(server);
              try {
                const result = connection
                  ? await connection.callTool(call.toolName, args)
                  : await options
                      .builtinExecutor!.callTool(call.toolName, args, {
                        // Composite tools stream progress ("scanning 214
                        // messages…") through the loop's activity channel.
                        emitActivity: (detail) =>
                          write(
                            emitAgentActivity('chat.activity.m365Progress', {
                              detail,
                            }),
                          ),
                      })
                      .then((r) => ({
                        text: r.resultText,
                        isError: r.isError,
                      }));
                write(
                  toolResultToRecordMarker(
                    call,
                    server.label,
                    result,
                    Date.now() - startedAt,
                  ),
                );
                let resultText = result.isError
                  ? `Tool failed: ${result.text}`
                  : result.text || '(empty result)';
                // One retry per plan step: an empty/failed result earns the
                // model a single adjusted-arguments retry nudge; the step is
                // marked so a second emptiness moves on quietly.
                if (
                  turnPlan &&
                  matchedStepIndex !== null &&
                  !turnPlan.steps[matchedStepIndex].retried &&
                  isEmptyToolResult(resultText, result.isError)
                ) {
                  turnPlan.steps[matchedStepIndex].retried = true;
                  resultText += RETRY_NUDGE;
                }
                results.push({
                  call,
                  text: resultText,
                  isError: result.isError,
                });
              } finally {
                await connection?.close();
              }
            } catch (error) {
              const isAuth = isMcpAuthError(error);
              const errorMessage = isAuth
                ? `Authentication with ${server.label} expired. Reconnect it in Settings → Connectors.`
                : error instanceof Error
                  ? error.message
                  : 'Tool call failed';
              write(
                toolResultToRecordMarker(
                  call,
                  server.label,
                  {
                    errorMessage,
                    ...(isAuth ? { errorKind: 'auth' as const } : {}),
                  },
                  Date.now() - startedAt,
                ),
              );
              let failureText = `Tool failed: ${errorMessage}`;
              // Auth failures aren't retryable with different arguments —
              // the nudge would just burn a round.
              if (
                !isAuth &&
                turnPlan &&
                matchedStepIndex !== null &&
                !turnPlan.steps[matchedStepIndex].retried
              ) {
                turnPlan.steps[matchedStepIndex].retried = true;
                failureText += RETRY_NUDGE;
              }
              results.push({
                call,
                text: failureText,
                isError: true,
              });
            }
          }

          messages = options.strategy.appendToolResults(messages, results);
        }

        // ── MODEL_ROUND. Past the round cap the strategy withholds tool use
        // (OpenAI: omit tools; Anthropic: tool_choice 'none' — its transcript
        // still contains tool blocks, so tools must stay declared).
        const round = await options.strategy.runModelRound(
          messages,
          serversWithTools,
          options.loopRound < (options.maxRounds ?? MAX_TOOL_ROUNDS),
          write,
        );

        if (round.usage) {
          const roundUsage: TokenUsageMetadata = {
            promptTokens: round.usage.promptTokens,
            completionTokens: round.usage.completionTokens,
            totalTokens: round.usage.totalTokens,
            modelId: options.usage.modelId,
            region: options.usage.region,
            reasoningEffort: options.usage.reasoningEffort,
          };
          options.usage.onUsage(roundUsage);
          aggregate.prompt += roundUsage.promptTokens;
          aggregate.completion += roundUsage.completionTokens;
          aggregate.total += roundUsage.totalTokens;
        }

        // ── PAUSE or DONE
        const assembled = round.finishedWithToolUse ? round.calls : [];
        for (const call of assembled) {
          const resolved = fromModelToolName(call.name, serversWithTools);
          if (!resolved) {
            // The model invented a tool name; surface it as failed rather
            // than asking the user to approve something undispatchable.
            write(
              toolResultToRecordMarker(
                {
                  id: call.id,
                  serverId: 'unknown',
                  toolName: call.name,
                  argumentsJson: call.argumentsJson,
                },
                'unknown',
                { errorMessage: 'Unknown tool' },
                0,
              ),
            );
            continue;
          }
          write(
            pendingCallToConsentMarker(
              {
                id: call.id,
                serverId: resolved.server.id,
                toolName: resolved.toolName,
                argumentsJson: call.argumentsJson,
              },
              resolved.server.label,
            ),
          );
        }

        const metadata: StreamMetadata = {};
        if (options.citations?.length) metadata.citations = options.citations;
        if (round.thinking) metadata.thinking = round.thinking;
        // The plan (with progress + retry state) rides the terminal block so
        // the client can echo it back on approval resume — same stateless
        // protocol as mcpPendingToolCalls.
        if (turnPlan) metadata.mcpPlan = turnPlan;
        if (aggregate.total > 0) {
          metadata.usage = {
            promptTokens: aggregate.prompt,
            completionTokens: aggregate.completion,
            totalTokens: aggregate.total,
            modelId: options.usage.modelId,
            region: options.usage.region,
            reasoningEffort: options.usage.reasoningEffort,
          };
        }
        if (
          metadata.citations ||
          metadata.usage ||
          metadata.thinking ||
          metadata.mcpPlan
        ) {
          appendMetadataToStream(controller, metadata);
        }
        controller.close();
      } catch (error) {
        // The real cause lives HERE only — the client gets a generic,
        // code-tagged message, so without this log a mid-loop failure is
        // undiagnosable.
        console.error(
          '[toolLoopCore] Tool loop failed mid-stream:',
          error instanceof Error ? `${error.name}: ${error.message}` : error,
        );
        // End the stream CLEANLY with an in-band error instead of killing
        // the socket: controller.error() aborts the response mid-transfer,
        // which reaches the browser as an opaque network failure (Firefox:
        // NS_ERROR_NET_PARTIAL_TRANSFER) carrying no information at all.
        try {
          appendMetadataToStream(controller, {
            streamError: {
              code: 'TOOL_LOOP_FAILED',
              message:
                'The assistant hit a problem while using connector tools and the response was interrupted.',
            },
          });
          controller.close();
        } catch {
          // Enqueueing failed (stream already errored/cancelled) — the
          // abort path is all that's left.
          controller.error(error);
        }
      }
    },
  });

  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
