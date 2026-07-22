import {
  StreamMetadata,
  TokenUsageMetadata,
  appendMetadataToStream,
} from '@/lib/utils/app/metadata';

import { ApprovalResponse } from '@/types/chat';
import { McpPendingToolCall } from '@/types/mcp';
import { Citation } from '@/types/rag';

import { connectMcp, isMcpAuthError } from './McpClientService';
import {
  deniedCallToOutcomeMarker,
  pendingCallToConsentMarker,
  toolResultToRecordMarker,
} from './mcpEventMappers';
import { DENIED_TOOL_RESULT } from './mcpEventMappers';
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
}

export interface ToolLoopCoreOptions<TMessage> {
  strategy: ToolLoopProviderStrategy<TMessage>;
  preparedMessages: TMessage[];
  servers: ResolvedMcpServer[];
  pendingToolCalls?: McpPendingToolCall[];
  approvalResponses?: ApprovalResponse[];
  loopRound: number;
  userId: string;
  citations?: Citation[];
  usage: {
    modelId: string;
    region: 'US' | 'EU' | null;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    onUsage: (usage: TokenUsageMetadata) => void;
  };
}

export async function listToolsForServers(
  servers: ResolvedMcpServer[],
  userId: string,
): Promise<{ serversWithTools: ServerWithTools[]; failedLabels: string[] }> {
  const failedLabels: string[] = [];
  const results = await Promise.all(
    servers.map(async (server): Promise<ServerWithTools> => {
      const cacheKey = toolCacheKey(userId, server.url, server.authToken);
      const cached = getCachedTools(cacheKey);
      if (cached) return { server, tools: cached };
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
          setCachedTools(cacheKey, tools);
          return { server, tools };
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

            write(
              emitAgentActivity('chat.activity.usingNamedToolWithService', {
                tool: call.toolName,
                service: server.label,
              }),
            );
            try {
              const connection = await connectMcp(server);
              try {
                const result = await connection.callTool(call.toolName, args);
                write(
                  toolResultToRecordMarker(
                    call,
                    server.label,
                    result,
                    Date.now() - startedAt,
                  ),
                );
                results.push({
                  call,
                  text: result.isError
                    ? `Tool failed: ${result.text}`
                    : result.text || '(empty result)',
                  isError: result.isError,
                });
              } finally {
                await connection.close();
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
              results.push({
                call,
                text: `Tool failed: ${errorMessage}`,
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
          options.loopRound < MAX_TOOL_ROUNDS,
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
        if (metadata.citations || metadata.usage || metadata.thinking) {
          appendMetadataToStream(controller, metadata);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
