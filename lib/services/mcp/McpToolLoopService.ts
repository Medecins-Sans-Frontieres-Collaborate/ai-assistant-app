import { ModelHandler } from '@/lib/services/chat/handlers/ModelHandler';

import { TokenUsageMetadata } from '@/lib/utils/app/metadata';

import { ApprovalResponse } from '@/types/chat';
import { McpPendingToolCall } from '@/types/mcp';
import { Citation } from '@/types/rag';

import { toolResultToMessage } from './mcpEventMappers';
import { createToolCallAccumulator } from './openaiToolCallAccumulator';
import {
  AssembledRound,
  ExecutedToolResult,
  ServerWithTools,
  ToolLoopProviderStrategy,
  runToolLoopCore,
} from './toolLoopCore';
import { reconstructTranscript } from './toolLoopReducer';
import { mcpToolsToOpenAITools } from './toolNameMapping';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import type OpenAI from 'openai';

/**
 * The native MCP tool loop for OpenAI-family models (chat.completions) — the
 * OpenAI provider strategy over runToolLoopCore. See toolLoopCore.ts for the
 * loop mechanics (LIST_TOOLS → RESUME → MODEL_ROUND → PAUSE/DONE, stateless
 * pause/resume mirroring the Foundry agent path).
 *
 * Deliberate v1 limits:
 * - MCP turns bypass createAzureOpenAIStreamProcessor: text deltas pass
 *   through raw and usage/citations ride the terminal metadata block.
 *   (<think> parsing is a non-issue — R1-style models don't support tools.)
 * - MCP turns opt out of the DeploymentNotFound fallback chain.
 * - Anthropic models take runAnthropicMcpToolLoop instead (see
 *   AnthropicMcpToolLoopService.ts).
 */

export interface McpToolLoopOptions {
  handler: ModelHandler;
  preparedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  buildParams: (
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ) => OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
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

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function buildOpenAIStrategy(
  options: McpToolLoopOptions,
): ToolLoopProviderStrategy<OpenAIMessage> {
  return {
    reconstructTranscript(messages, pending) {
      return reconstructTranscript(messages, pending);
    },

    appendToolResults(messages, results: ExecutedToolResult[]) {
      // OpenAI matches results to calls by tool_call_id, one role:'tool'
      // message per result; order is irrelevant but kept for readability.
      return [
        ...messages,
        ...results.map((result) =>
          toolResultToMessage(result.call, result.text),
        ),
      ];
    },

    async runModelRound(
      messages,
      serversWithTools: ServerWithTools[],
      allowToolUse,
      write,
    ): Promise<AssembledRound> {
      const params = options.buildParams(messages);
      const openAITools = serversWithTools.flatMap(({ server, tools }) =>
        mcpToolsToOpenAITools(server.id, tools),
      );
      // Past the round cap the model gets no tools: unlike Anthropic, an
      // OpenAI transcript with tool messages but no tools declared is legal.
      if (openAITools.length > 0 && allowToolUse) {
        params.tools = openAITools;
      }

      const completionStream = (await options.handler.executeRequest(
        params,
        true,
      )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

      const accumulator = createToolCallAccumulator();
      for await (const chunk of completionStream) {
        write(accumulator.ingest(chunk));
      }

      return {
        finishedWithToolUse: accumulator.finishReason === 'tool_calls',
        calls: accumulator.toolCalls(),
        usage: accumulator.usage
          ? {
              promptTokens: accumulator.usage.prompt_tokens ?? 0,
              completionTokens: accumulator.usage.completion_tokens ?? 0,
              totalTokens: accumulator.usage.total_tokens ?? 0,
            }
          : null,
      };
    },
  };
}

export async function runMcpToolLoop(
  options: McpToolLoopOptions,
): Promise<Response> {
  return runToolLoopCore<OpenAIMessage>({
    strategy: buildOpenAIStrategy(options),
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
