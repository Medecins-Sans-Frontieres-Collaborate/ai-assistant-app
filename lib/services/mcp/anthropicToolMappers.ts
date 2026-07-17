import { McpPendingToolCall } from '@/types/mcp';

import { ExecutedToolResult } from './toolLoopCore';
import { parseToolArguments } from './toolLoopReducer';
import { toModelToolName } from './toolNameMapping';
import { McpToolDefinition } from './toolSchemaCache';

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic-flavored message/tool shapes for the MCP tool loop — the Claude
 * twin of the OpenAI halves of mcpEventMappers/toolLoopReducer. Stream
 * markers (consent/tool-record) are provider-agnostic and reused as-is.
 */

/** MCP tool definitions → Anthropic `tools` declarations. */
export function mcpToolsToAnthropicTools(
  serverId: string,
  tools: McpToolDefinition[],
): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: toModelToolName(serverId, tool.name),
    ...(tool.description ? { description: tool.description } : {}),
    // Anthropic rejects non-object schemas; some MCP servers omit `type`.
    input_schema: {
      ...tool.inputSchema,
      type: 'object' as const,
    },
  }));
}

/** Extracts the plain text of an Anthropic message's content. */
function contentText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

/**
 * The reconstructed assistant message for the resume round: text block (when
 * the model streamed any before pausing) followed by one tool_use block per
 * pending call. NOTE: `input` is a PARSED OBJECT — Anthropic does not accept
 * a JSON string there. Unparseable arguments degrade to {}; the execution
 * side independently surfaces the parse failure as a failed tool result.
 */
export function pendingCallsToAssistantAnthropicMessage(
  pending: McpPendingToolCall[],
  assistantText: string | null,
): Anthropic.MessageParam {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (assistantText) {
    blocks.push({ type: 'text', text: assistantText });
  }
  for (const call of pending) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: toModelToolName(call.serverId, call.toolName),
      input: parseToolArguments(call.argumentsJson) ?? {},
    });
  }
  return { role: 'assistant', content: blocks };
}

/**
 * Rebuilds a legal Anthropic transcript for the resume round — same
 * trailing-assistant-replace / else-append rule as the OpenAI
 * reconstructTranscript. The caller MUST follow this with
 * executedResultsToUserMessage() covering every pending call: an assistant
 * tool_use message without a complete tool_result follow-up is illegal.
 */
export function reconstructAnthropicTranscript(
  messages: Anthropic.MessageParam[],
  pending: McpPendingToolCall[],
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    return [
      ...messages.slice(0, -1),
      pendingCallsToAssistantAnthropicMessage(
        pending,
        contentText(last.content) || null,
      ),
    ];
  }
  return [...messages, pendingCallsToAssistantAnthropicMessage(pending, null)];
}

/**
 * ALL pending-call results as ONE user message of tool_result blocks, in
 * pending order — Anthropic requires the tool_result message to immediately
 * follow the assistant tool_use message and to cover every tool_use id.
 * `is_error` marks genuine failures only; a user denial is not a tool
 * malfunction.
 */
export function executedResultsToUserMessage(
  results: ExecutedToolResult[],
): Anthropic.MessageParam {
  return {
    role: 'user',
    content: results.map((result) => ({
      type: 'tool_result' as const,
      tool_use_id: result.call.id,
      content: result.text,
      ...(result.isError ? { is_error: true } : {}),
    })),
  };
}
