import { AnthropicFoundryHandler } from '@/lib/services/chat/handlers/AnthropicFoundryHandler';

import { TokenUsageMetadata } from '@/lib/utils/app/metadata';

import { ApprovalResponse } from '@/types/chat';
import { McpPendingToolCall } from '@/types/mcp';
import { Citation } from '@/types/rag';

import {
  executedResultsToUserMessage,
  mcpToolsToAnthropicTools,
  reconstructAnthropicTranscript,
} from './anthropicToolMappers';
import { createAnthropicToolUseAccumulator } from './anthropicToolUseAccumulator';
import {
  AssembledRound,
  ServerWithTools,
  ToolLoopProviderStrategy,
  runToolLoopCore,
} from './toolLoopCore';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * The native MCP tool loop for Anthropic Claude models — the Anthropic
 * provider strategy over runToolLoopCore. Same stateless pause/resume
 * protocol as the OpenAI loop; only the transcript shapes (tool_use /
 * tool_result blocks) and stream accumulation differ.
 *
 * THINKING GUARD: extended thinking is currently never enabled for Claude in
 * this app (no `thinking` param anywhere). If that ever changes, MCP turns
 * MUST keep thinking disabled — the stateless pause/resume cannot round-trip
 * the signed thinking blocks Anthropic requires when continuing a tool-use
 * turn from a client-persisted, text-only transcript.
 */

export interface AnthropicMcpToolLoopOptions {
  handler: AnthropicFoundryHandler;
  preparedMessages: Anthropic.MessageParam[];
  buildParams: (
    messages: Anthropic.MessageParam[],
  ) => Anthropic.MessageCreateParamsStreaming;
  servers: ResolvedMcpServer[];
  pendingToolCalls?: McpPendingToolCall[];
  approvalResponses?: ApprovalResponse[];
  loopRound: number;
  userId: string;
  citations?: Citation[];
  usage: {
    modelId: string;
    region: 'US' | 'EU' | null;
    onUsage: (usage: TokenUsageMetadata) => void;
  };
}

function buildAnthropicStrategy(
  options: AnthropicMcpToolLoopOptions,
): ToolLoopProviderStrategy<Anthropic.MessageParam> {
  return {
    reconstructTranscript(messages, pending) {
      return reconstructAnthropicTranscript(messages, pending);
    },

    appendToolResults(messages, results) {
      // Anthropic requires ONE user message of tool_result blocks that
      // immediately follows the assistant tool_use message and covers every
      // tool_use id — executedResultsToUserMessage guarantees both.
      return [...messages, executedResultsToUserMessage(results)];
    },

    async runModelRound(
      messages,
      serversWithTools: ServerWithTools[],
      allowToolUse,
      write,
    ): Promise<AssembledRound> {
      const params = options.buildParams(messages);
      const anthropicTools = serversWithTools.flatMap(({ server, tools }) =>
        mcpToolsToAnthropicTools(server.id, tools),
      );
      if (anthropicTools.length > 0) {
        // Unlike OpenAI, tools must STAY declared past the round cap: the
        // resume transcript contains tool_use/tool_result blocks, and
        // Anthropic rejects such transcripts when no tools are declared.
        // tool_choice 'none' is how a capped round forbids further calls.
        params.tools = anthropicTools;
        if (!allowToolUse) {
          params.tool_choice = { type: 'none' };
        }
      }

      const eventStream = await options.handler.executeStreamingRequest(params);

      const accumulator = createAnthropicToolUseAccumulator();
      for await (const event of eventStream) {
        write(accumulator.ingest(event));
      }

      return {
        finishedWithToolUse: accumulator.stopReason === 'tool_use',
        calls: accumulator.toolUses(),
        usage: accumulator.usage
          ? {
              promptTokens: accumulator.usage.inputTokens,
              completionTokens: accumulator.usage.outputTokens,
              totalTokens:
                accumulator.usage.inputTokens + accumulator.usage.outputTokens,
            }
          : null,
        thinking: accumulator.thinking || undefined,
      };
    },
  };
}

export async function runAnthropicMcpToolLoop(
  options: AnthropicMcpToolLoopOptions,
): Promise<Response> {
  return runToolLoopCore<Anthropic.MessageParam>({
    strategy: buildAnthropicStrategy(options),
    preparedMessages: options.preparedMessages,
    servers: options.servers,
    pendingToolCalls: options.pendingToolCalls,
    approvalResponses: options.approvalResponses,
    loopRound: options.loopRound,
    userId: options.userId,
    citations: options.citations,
    usage: options.usage,
  });
}
