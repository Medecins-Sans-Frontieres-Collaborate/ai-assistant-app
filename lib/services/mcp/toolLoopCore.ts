import { MAX_OVERFLOW_SHRINKS } from '@/lib/services/chat/contextOverflowRecovery';
import {
  MODEL_RETRY_ACTIVITY_KEY,
  createRetryPolicy,
  retryActivityParams,
  sleepWithSignal,
} from '@/lib/services/chat/modelRetry';
import { classifyProviderError } from '@/lib/services/chat/providerErrors';
import {
  CONTENT_FILTER_STREAM_ERROR,
  ContinuationBudget,
  ContinuationReason,
  OUTPUT_LIMIT_STREAM_ERROR,
  RoundFinish,
  TRIM_CONTEXT_ACTIVITY_KEY,
  continuationActivityKey,
} from '@/lib/services/chat/streamContinuation';
import { mintContinuationToken } from '@/lib/services/limits/continuationToken';
import type { M365BuiltinExecutor } from '@/lib/services/m365/tools/executor';
import { MetricsService } from '@/lib/services/observability/MetricsService';
import { ToolCallTelemetry } from '@/lib/services/observability/tokenUsageRecorder';

import {
  StreamMetadata,
  TokenUsageMetadata,
  appendMetadataToStream,
} from '@/lib/utils/app/metadata';

import { ApprovalResponse } from '@/types/chat';
import { McpPendingToolCall, McpPlan, McpPlanStep } from '@/types/mcp';
import { Citation } from '@/types/rag';

import { connectMcp, isMcpAuthError } from './McpClientService';
import type { BuiltinExecutor } from './builtinExecutor';
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
/**
 * Per tool call wall-clock budget. A connector that hangs would otherwise
 * stall the turn until the pipeline stage timer fires — which the client
 * reports as "the model did not start responding", untrue and misleading.
 * A tool that overruns is recorded as a failed call and the model is told.
 */
export const TOOL_CALL_BUDGET_MS = 120_000;
const LIST_TOOLS_BUDGET_MS = 10_000;
/**
 * Approved calls of one resume batch run concurrently up to this many at a
 * time. Connector calls are independent (each opens its own connection);
 * builtin executors are request-bound and already handle concurrent Graph
 * calls. Results are still fed back in pending order.
 */
export const TOOL_CALL_CONCURRENCY = 4;
/**
 * Model-facing cap on one tool result (~15k tokens). The UI record has its
 * own cap (mcpEventMappers.truncateToolOutput); THIS one protects the
 * context window — a 2 MB connector payload must not blow the next round.
 */
export const MAX_MODEL_TOOL_RESULT_CHARS = 60_000;

/** Cap a tool result for the model, with an explicit, actionable trailer. */
/**
 * What the browser's TOOL_CALL_RECORD shows for a builtin result: the
 * executor's summary when it provides one, else the full text. The model
 * transcript always gets the full text.
 */
function recordText(
  executor: BuiltinExecutor | undefined,
  toolName: string,
  args: unknown,
  result: { resultText: string; isError: boolean },
): string {
  return executor?.recordOutput
    ? executor.recordOutput(toolName, args, result)
    : result.resultText;
}

export function capToolResultForModel(text: string): string {
  if (text.length <= MAX_MODEL_TOOL_RESULT_CHARS) return text;
  const dropped = text.length - MAX_MODEL_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_MODEL_TOOL_RESULT_CHARS)}\n\n[Tool result truncated: ${dropped} more characters were omitted. Ask for a narrower query, a page, or a specific field if you need the rest.]`;
}

export interface ServerWithTools {
  server: ResolvedMcpServer;
  tools: McpToolDefinition[];
  /** Server-declared usage guidance from the initialize handshake. */
  instructions?: string;
  transcriptTools?: McpToolDefinition[];
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
  /**
   * Normalised terminal finish (lib/services/chat/streamContinuation.ts).
   * `length` triggers an output-limit continuation, `content_filter` ends
   * the turn with an in-band error. Absent = treated as a normal stop.
   */
  finish?: RoundFinish;
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
   *
   * `onModelStarted` MUST be called as soon as the provider has opened the
   * response stream (its request promise resolved — headers received),
   * BEFORE consuming it. `runToolLoopCore` holds back its Response until
   * then, which is what lets the pipeline's model-start timeout (issue
   * #130) cover an MCP turn: without it the Response returned instantly
   * and the stage timer was cancelled before the model was ever called.
   */
  runModelRound(
    messages: TMessage[],
    serversWithTools: ServerWithTools[],
    allowToolUse: boolean,
    write: (text: string) => void,
    onModelStarted?: () => void,
  ): Promise<AssembledRound>;
  /**
   * Receive the connector-instructions addendum (trusted servers'
   * sanitized initialize `instructions`) to fold into every model round's
   * system prompt. Called once, after LIST_TOOLS, before any round.
   */
  applySystemAddendum?(addendum: string): void;
  /**
   * Mid-answer recovery: append the partial assistant text already shown
   * to the user plus a "continue" nudge (continuationNudge(reason)) so the
   * next round picks up where the interrupted / length-capped one stopped.
   * Absent = interruptions end the turn, `length` finishes stand as-is.
   */
  appendContinuation?(
    messages: TMessage[],
    partialText: string,
    reason: ContinuationReason,
  ): TMessage[];
  /**
   * Context-overflow recovery: drop old history (never the current turn's
   * tool exchange) and return the shorter transcript, or null when nothing
   * more can be dropped. Absent = an overflow surfaces as a failure.
   */
  shrinkForOverflow?(messages: TMessage[]): TMessage[] | null;
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
  /** Telemetry sink for each EXECUTED tool call (approved + dispatched). */
  onToolCall?: (info: ToolCallTelemetry) => void;
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
  builtinExecutors?: Record<string, BuiltinExecutor>;
  /** Internal read-only tool rounds are separate from connector approval rounds. */
  maxImmediateRounds?: number;
  /**
   * Request-level cancellation (stage timeout, request guard, client gone).
   * Checked before every tool dispatch and model round so an abandoned turn
   * stops executing (and metering) instead of running to completion unseen.
   */
  signal?: AbortSignal;
}

export async function listToolsForServers(
  servers: ResolvedMcpServer[],
  userId: string,
  builtinExecutor?: M365BuiltinExecutor,
  builtinExecutors?: Record<string, BuiltinExecutor>,
): Promise<{ serversWithTools: ServerWithTools[]; failedLabels: string[] }> {
  const failedLabels: string[] = [];
  const results = await Promise.all(
    servers.map(async (server): Promise<ServerWithTools> => {
      if (server.provenance === 'builtin') {
        const executor: BuiltinExecutor | undefined =
          builtinExecutors?.[server.id] ?? builtinExecutor;
        // Builtin servers list in-process: no connection, and no
        // toolSchemaCache entry — its (userId, url, authToken) key shape
        // never applies to a url-less synthetic server, and the executor
        // does its own consent-probe caching.
        if (!executor) return { server, tools: [] };
        try {
          const tools = await withBudget(
            executor.listTools(),
            LIST_TOOLS_BUDGET_MS,
          );
          return {
            server,
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
            instructions: executor.instructions,
            ...(executor.transcriptTools
              ? { transcriptTools: executor.transcriptTools() }
              : {}),
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

  // Resolved once the provider has opened the model's response stream (or
  // the loop ended before it could). The Response is only returned after
  // that, so the caller's timeout — the pipeline stage racing this call —
  // spans LIST_TOOLS, planning, resumed tool execution AND the model's
  // time-to-first-byte, exactly as it does for a plain (non-MCP) turn.
  // Everything written before then just queues in the ReadableStream.
  let markModelStarted!: () => void;
  const modelStarted = new Promise<void>((resolve) => {
    markModelStarted = resolve;
  });

  const stream = new ReadableStream({
    async start(controller) {
      const write = (text: string) => {
        if (text) controller.enqueue(encoder.encode(text));
      };
      const aggregate = { prompt: 0, completion: 0, total: 0 };
      const checkAborted = () => options.signal?.throwIfAborted();
      const budgeted = <T>(promise: Promise<T>) =>
        withBudget(promise, TOOL_CALL_BUDGET_MS).catch((error: unknown) => {
          if (error instanceof Error && error.message === 'MCP budget exceeded')
            throw new Error(
              `Tool call did not finish within ${TOOL_CALL_BUDGET_MS / 1000} seconds`,
            );
          throw error;
        });

      try {
        // ── LIST_TOOLS (cache makes resume rounds cheap)
        write(emitAgentActivity('chat.activity.listingTools'));
        const { serversWithTools, failedLabels } = await listToolsForServers(
          options.servers,
          options.userId,
          options.builtinExecutor,
          options.builtinExecutors,
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
        // Explicit preloads are rendered as real tool exchanges without
        // adding their instruction bodies to the persona system prompt.
        for (const [serverId, executor] of Object.entries(
          options.builtinExecutors ?? {},
        )) {
          for (const preload of (await executor.preload?.()) ?? []) {
            const call = {
              id: `preload-${crypto.randomUUID()}`,
              serverId,
              toolName: preload.toolName,
              argumentsJson: preload.argumentsJson,
            };
            messages = options.strategy.reconstructTranscript(messages, [call]);
            messages = options.strategy.appendToolResults(messages, [
              {
                call,
                text: capToolResultForModel(preload.result.resultText),
                isError: preload.result.isError,
              },
            ]);
            write(
              toolResultToRecordMarker(
                call,
                serverById.get(serverId)?.label ?? 'Skills',
                {
                  text: recordText(
                    executor,
                    preload.toolName,
                    parseToolArguments(preload.argumentsJson),
                    preload.result,
                  ),
                  isError: preload.result.isError,
                },
                0,
              ),
            );
          }
        }

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

          // Approved calls run CONCURRENTLY (TOOL_CALL_CONCURRENCY at a
          // time); results land at their pending index so the transcript
          // order is unchanged. Three 30 s connector calls now cost 30 s,
          // not 90.
          const results: ExecutedToolResult[] = new Array(pending.length);
          const executeOne = async (
            call: McpPendingToolCall,
            index: number,
          ): Promise<void> => {
            if (decisionById.get(call.id) !== 'approved') {
              results[index] = {
                call,
                text: DENIED_TOOL_RESULT,
                isError: false,
              };
              return;
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
              results[index] = {
                call,
                text: `Tool failed: ${errorMessage}`,
                isError: true,
              };
              return;
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
                server.provenance === 'builtin' &&
                (options.builtinExecutors?.[server.id] ??
                  options.builtinExecutor)
                  ? null
                  : await connectMcp(server);
              try {
                checkAborted();
                const result = connection
                  ? await budgeted(connection.callTool(call.toolName, args))
                  : await budgeted(
                      (options.builtinExecutors?.[server.id] ??
                        options.builtinExecutor)!
                        .callTool(call.toolName, args, {
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
                        })),
                    );
                const resumedExecutor = connection
                  ? undefined
                  : (options.builtinExecutors?.[server.id] ??
                    options.builtinExecutor);
                write(
                  toolResultToRecordMarker(
                    call,
                    server.label,
                    resumedExecutor
                      ? {
                          text: recordText(
                            resumedExecutor,
                            call.toolName,
                            args,
                            {
                              resultText: result.text,
                              isError: result.isError,
                            },
                          ),
                          isError: result.isError,
                        }
                      : result,
                    Date.now() - startedAt,
                  ),
                );
                options.onToolCall?.({
                  toolName: call.toolName,
                  serverId: server.id,
                  serverLabel: server.label,
                  durationMs: Date.now() - startedAt,
                  success: !result.isError,
                  errorMessage: result.isError ? result.text : undefined,
                });
                let resultText = result.isError
                  ? `Tool failed: ${result.text}`
                  : capToolResultForModel(result.text) || '(empty result)';
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
                results[index] = {
                  call,
                  text: resultText,
                  isError: result.isError,
                };
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
              options.onToolCall?.({
                toolName: call.toolName,
                serverId: server.id,
                serverLabel: server.label,
                durationMs: Date.now() - startedAt,
                success: false,
                errorMessage,
              });
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
              results[index] = {
                call,
                text: failureText,
                isError: true,
              };
            }
          };

          // Bounded worker pool over the pending list.
          let nextIndex = 0;
          const workers = Array.from(
            { length: Math.min(TOOL_CALL_CONCURRENCY, pending.length) },
            async () => {
              for (;;) {
                const index = nextIndex++;
                if (index >= pending.length) return;
                await executeOne(pending[index], index);
              }
            },
          );
          await Promise.all(workers);

          messages = options.strategy.appendToolResults(messages, results);
        }

        /**
         * One model round with in-turn recovery (see
         * lib/services/chat/modelRetry.ts and streamContinuation.ts):
         *  - a failure BEFORE any text reached the client is retried with
         *    backoff (rate limit, 5xx, connection) — the loader says so;
         *  - a failure AFTER text streamed is continued on the same model
         *    with the partial + a "continue" nudge (the client keeps what
         *    it has; no tool re-runs on a fallback model);
         *  - a `length` finish with text is continued the same way, capped;
         *  - a context overflow shrinks old history and re-runs;
         *  - a content-filter stop ends the turn with an in-band error.
         * Returns the round plus the transcript it was produced from (a
         * continuation appends to it), so later steps build on the right
         * messages.
         */
        const runRoundWithRecovery = async (
          roundInput: TMessage[],
          roundServers: ServerWithTools[],
          allowToolUse: boolean,
        ): Promise<{
          round: AssembledRound;
          messages: TMessage[];
          terminal?: 'content_filter' | 'output_limit';
        }> => {
          let roundMessages = roundInput;
          let roundText = '';
          const trackedWrite = (text: string) => {
            roundText += text;
            write(text);
          };
          const policy = createRetryPolicy();
          const budget = new ContinuationBudget();
          let overflowShrinks = 0;
          const usageAcc = { prompt: 0, completion: 0, total: 0, seen: false };
          const mergeUsage = (round: AssembledRound): AssembledRound => {
            if (round.usage) {
              usageAcc.prompt += round.usage.promptTokens;
              usageAcc.completion += round.usage.completionTokens;
              usageAcc.total += round.usage.totalTokens;
              usageAcc.seen = true;
            }
            return usageAcc.seen
              ? {
                  ...round,
                  usage: {
                    promptTokens: usageAcc.prompt,
                    completionTokens: usageAcc.completion,
                    totalTokens: usageAcc.total,
                  },
                }
              : round;
          };
          const continueWith = (reason: ContinuationReason): boolean => {
            if (!options.strategy.appendContinuation || !budget.take(reason))
              return false;
            write(emitAgentActivity(continuationActivityKey(reason)));
            MetricsService.recordModelRecovery(
              reason === 'length' ? 'continue' : 'resume',
              reason === 'length' ? 'output_limit' : 'incomplete_stream',
            );
            roundMessages = options.strategy.appendContinuation(
              roundMessages,
              roundText,
              reason,
            );
            return true;
          };
          for (;;) {
            checkAborted();
            try {
              const round = mergeUsage(
                await options.strategy.runModelRound(
                  roundMessages,
                  roundServers,
                  allowToolUse,
                  trackedWrite,
                  markModelStarted,
                ),
              );
              if (round.finish === 'content_filter')
                return {
                  round,
                  messages: roundMessages,
                  terminal: 'content_filter',
                };
              if (round.finish === 'length' && !round.finishedWithToolUse) {
                if (!roundText.trim())
                  return {
                    round,
                    messages: roundMessages,
                    terminal: 'output_limit',
                  };
                if (continueWith('length')) continue;
              }
              return { round, messages: roundMessages };
            } catch (error) {
              if (options.signal?.aborted) throw error;
              const classified = classifyProviderError(error);
              if (
                classified.kind === 'context_overflow' &&
                options.strategy.shrinkForOverflow &&
                overflowShrinks < MAX_OVERFLOW_SHRINKS
              ) {
                const shrunk =
                  options.strategy.shrinkForOverflow(roundMessages);
                if (shrunk) {
                  overflowShrinks += 1;
                  console.warn(
                    `[toolLoopCore] prompt too long for the model; retrying with ${shrunk.length} of ${roundMessages.length} messages`,
                  );
                  MetricsService.recordModelRecovery(
                    'trim',
                    'context_overflow',
                  );
                  write(emitAgentActivity(TRIM_CONTEXT_ACTIVITY_KEY));
                  roundMessages = shrunk;
                  continue;
                }
              }
              if (classified.kind === 'content_filter')
                return {
                  round: { finishedWithToolUse: false, calls: [], usage: null },
                  messages: roundMessages,
                  terminal: 'content_filter',
                };
              if (!classified.retryable) throw error;
              if (!roundText.trim()) {
                // Nothing reached the client yet: a plain retry is safe.
                const decision = policy.decide(error);
                if (!decision.retry) {
                  if (decision.reason !== 'not_retryable')
                    MetricsService.recordModelRecovery(
                      'give_up',
                      classified.kind,
                    );
                  throw error;
                }
                console.warn(
                  `[toolLoopCore] model round failed (${classified.kind}${classified.status ? ` ${classified.status}` : ''}); retrying in ${decision.delayMs} ms (attempt ${decision.attempt})`,
                );
                MetricsService.recordModelRecovery('retry', classified.kind);
                write(
                  emitAgentActivity(
                    MODEL_RETRY_ACTIVITY_KEY,
                    retryActivityParams({
                      attempt: decision.attempt,
                      delayMs: decision.delayMs,
                      error: classified,
                    }),
                  ),
                );
                await sleepWithSignal(decision.delayMs, options.signal);
                continue;
              }
              // Text already streamed: continue from it on the same model.
              console.warn(
                `[toolLoopCore] model stream interrupted (${classified.kind}) after ${roundText.length} chars; attempting continuation`,
              );
              if (continueWith('interrupted')) continue;
              throw error;
            }
          }
        };

        // ── MODEL_ROUND. Past the round cap the strategy withholds tool use
        // (OpenAI: omit tools; Anthropic: tool_choice 'none' — its transcript
        // still contains tool blocks, so tools must stay declared).
        let round: AssembledRound;
        let terminalFailure: 'content_filter' | 'output_limit' | undefined;
        let immediateRounds = 0;
        while (true) {
          for (const entry of serversWithTools) {
            const executor =
              entry.server.provenance === 'builtin'
                ? options.builtinExecutors?.[entry.server.id]
                : undefined;
            if (executor?.immediate) {
              entry.tools =
                immediateRounds >= (options.maxImmediateRounds ?? 3) ||
                executor.remainingRounds?.() === 0
                  ? []
                  : await executor.listTools();
            }
          }
          checkAborted();
          const outcome = await runRoundWithRecovery(
            messages,
            serversWithTools.map((entry) => ({
              ...entry,
              transcriptTools: entry.transcriptTools ?? entry.tools,
              tools:
                options.loopRound >= (options.maxRounds ?? MAX_TOOL_ROUNDS) &&
                !options.builtinExecutors?.[entry.server.id]?.immediate
                  ? []
                  : entry.tools,
            })),
            options.loopRound < (options.maxRounds ?? MAX_TOOL_ROUNDS) ||
              serversWithTools.some(
                (entry) =>
                  options.builtinExecutors?.[entry.server.id]?.immediate &&
                  entry.tools.length > 0,
              ),
          );
          round = outcome.round;
          messages = outcome.messages;
          if (outcome.terminal) {
            terminalFailure = outcome.terminal;
          }

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

          // A content-filter stop / empty output-limit finish ends the turn
          // here: no tool dispatch, no consent cards — the terminal metadata
          // block below carries the in-band error.
          if (terminalFailure) break;

          // ── PAUSE or DONE
          const assembled = round.finishedWithToolUse ? round.calls : [];
          const immediateResults: ExecutedToolResult[] = [];
          const approvalCalls: typeof assembled = [];
          for (const call of assembled) {
            const resolved = fromModelToolName(call.name, serversWithTools);
            const executor =
              resolved?.server.provenance === 'builtin'
                ? options.builtinExecutors?.[resolved.server.id]
                : undefined;
            const immediateArgs = resolved
              ? parseToolArguments(call.argumentsJson)
              : null;
            // A builtin may hold back one call for approval (a consent-gated
            // skill) while its other tools stay immediate.
            if (
              !resolved ||
              !executor?.immediate ||
              executor.requiresApproval?.(resolved.toolName, immediateArgs)
            ) {
              approvalCalls.push(call);
              continue;
            }
            const pending = {
              id: call.id,
              serverId: resolved.server.id,
              toolName: resolved.toolName,
              argumentsJson: call.argumentsJson,
            };
            const startedAt = Date.now();
            checkAborted();
            const outcome = await budgeted(
              executor.callTool(resolved.toolName, immediateArgs),
            ).catch((error: unknown) => ({
              resultText:
                error instanceof Error ? error.message : 'Tool call failed',
              isError: true,
            }));
            write(
              toolResultToRecordMarker(
                pending,
                resolved.server.label,
                {
                  text: recordText(
                    executor,
                    resolved.toolName,
                    immediateArgs,
                    outcome,
                  ),
                  isError: outcome.isError,
                },
                Date.now() - startedAt,
              ),
            );
            immediateResults.push({
              call: pending,
              text: capToolResultForModel(outcome.resultText),
              isError: outcome.isError,
            });
            options.onToolCall?.({
              toolName: resolved.toolName,
              serverId: resolved.server.id,
              serverLabel: resolved.server.label,
              durationMs: Date.now() - startedAt,
              success: !outcome.isError,
            });
          }
          if (immediateResults.length) {
            for (const id of new Set(
              immediateResults.map((result) => result.call.serverId),
            ))
              options.builtinExecutors?.[id]?.completeRound?.();
            immediateRounds += 1;
            // Keep the preceding user/tool-result message intact. Reconstruction
            // replaces ONLY the assistant turn just produced by this model round.
            messages = options.strategy.reconstructTranscript(
              messages,
              immediateResults.map((result) => result.call),
            );
            messages = options.strategy.appendToolResults(
              messages,
              immediateResults,
            );
            if (!approvalCalls.length) continue;
          }
          const continuationState = Object.fromEntries(
            Object.entries(options.builtinExecutors ?? {})
              .filter(([, executor]) => executor.continuationState)
              .map(([id, executor]) => [id, executor.continuationState!()]),
          );
          for (const call of approvalCalls) {
            const resolved = fromModelToolName(call.name, serversWithTools);
            const pastCap =
              options.loopRound >= (options.maxRounds ?? MAX_TOOL_ROUNDS);
            if (!resolved || pastCap) {
              // Either the model invented a tool name, or it asked for a
              // connector tool after the round cap (its tools were withheld,
              // but a skills-only round can still echo a remembered name).
              // Surface it as failed — truthfully labelled — rather than
              // asking the user to approve something undispatchable.
              write(
                toolResultToRecordMarker(
                  {
                    id: call.id,
                    serverId: resolved?.server.id ?? 'unknown',
                    toolName: resolved?.toolName ?? call.name,
                    argumentsJson: call.argumentsJson,
                  },
                  resolved?.server.label ?? 'unknown',
                  {
                    errorMessage: pastCap
                      ? 'Tool round limit reached for this message; the call was not executed.'
                      : 'Unknown tool',
                  },
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
                // Proof of issuance for the resume's limits check — see
                // lib/services/limits/continuationToken.ts.
                mintContinuationToken(
                  options.userId,
                  call.id,
                  Date.now(),
                  Object.keys(continuationState).length
                    ? continuationState
                    : undefined,
                ),
              ),
            );
          }
          break;
        }

        const metadata: StreamMetadata = {};
        if (options.citations?.length) metadata.citations = options.citations;
        for (const executor of Object.values(options.builtinExecutors ?? {})) {
          const data = executor.metadata?.();
          if (data?.citations.length) metadata.citations = data.citations;
          if (data && Object.keys(data.citationQuoteSources).length)
            metadata.citationQuoteSources = data.citationQuoteSources;
        }
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
        if (terminalFailure === 'content_filter') {
          metadata.streamError = { ...CONTENT_FILTER_STREAM_ERROR };
        } else if (terminalFailure === 'output_limit') {
          metadata.streamError = { ...OUTPUT_LIMIT_STREAM_ERROR };
        }
        if (
          metadata.citations ||
          metadata.usage ||
          metadata.thinking ||
          metadata.mcpPlan ||
          metadata.streamError
        ) {
          appendMetadataToStream(controller, metadata);
        }
        controller.close();
      } catch (error) {
        if (options.signal?.aborted) {
          // Request cancelled (client gone, stage timeout already reported
          // by the route). Nobody is reading — end quietly.
          try {
            controller.close();
          } catch {
            // already closed
          }
          return;
        }
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
          const classified = classifyProviderError(error);
          appendMetadataToStream(controller, {
            streamError: {
              code: 'TOOL_LOOP_FAILED',
              kind: classified.kind,
              message:
                classified.kind === 'context_overflow'
                  ? 'This conversation is too long for the selected model, even after trimming older history. Start a new conversation, or remove some attachments.'
                  : classified.kind === 'rate_limit'
                    ? 'The model is receiving too many requests right now and the response was interrupted. Please try again in a moment.'
                    : 'The assistant hit a problem while using connector tools and the response was interrupted.',
            },
          });
          controller.close();
        } catch {
          // Enqueueing failed (stream already errored/cancelled) — the
          // abort path is all that's left.
          controller.error(error);
        }
      } finally {
        // A loop that never reached (or never signalled) a model round
        // still has to hand its stream back — failures above end it with
        // an in-band streamError the client must get to read.
        markModelStarted();
      }
    },
  });

  await modelStarted;
  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
