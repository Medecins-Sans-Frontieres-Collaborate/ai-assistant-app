import { McpPendingToolCall } from '@/types/mcp';

import { AssembledToolCall } from './openaiToolCallAccumulator';

import {
  emitConsentOutcome,
  emitConsentRequest,
  emitToolCallRecord,
} from '@/lib/streamMarkers';
import type OpenAI from 'openai';

/**
 * Pure mappers between MCP tool-loop events and the stream-marker protocol
 * the client already renders (built for the Foundry agent path). Mirrors the
 * foundryEventMappers.ts pattern: every marker the loop emits is produced by
 * a testable function here.
 */

const MAX_OUTPUT_CHARS = 30_000;

export function truncateToolOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${output.length - MAX_OUTPUT_CHARS} characters]`;
}

/** Consent card for one pending tool call (the PAUSE handoff). */
export function pendingCallToConsentMarker(
  call: McpPendingToolCall,
  serverLabel: string,
): string {
  return emitConsentRequest({
    kind: 'approval',
    approval_request_id: call.id,
    server_id: call.serverId,
    server_label: serverLabel,
    tool_name: call.toolName,
    tool_arguments: call.argumentsJson,
  });
}

/** Record marker for an executed (or failed) tool call. */
export function toolResultToRecordMarker(
  call: McpPendingToolCall,
  serverLabel: string,
  result:
    | { text: string; isError: boolean }
    | { errorMessage: string; errorKind?: 'auth' },
  durationMs: number,
): string {
  const failed = 'errorMessage' in result || result.isError;
  return emitToolCallRecord({
    id: call.id,
    name: call.toolName,
    server_label: serverLabel,
    server_id: call.serverId,
    arguments: call.argumentsJson,
    status: failed ? 'failed' : 'completed',
    output: 'errorMessage' in result ? null : truncateToolOutput(result.text),
    error: 'errorMessage' in result ? result.errorMessage : null,
    ...('errorMessage' in result && result.errorKind
      ? { error_kind: result.errorKind }
      : {}),
    duration_ms: durationMs,
    approval_request_id: call.id,
  });
}

/** Outcome marker flipping a consent card out of "pending" (deny paths). */
export function deniedCallToOutcomeMarker(approvalRequestId: string): string {
  return emitConsentOutcome({
    approval_request_id: approvalRequestId,
    approve: false,
  });
}

/**
 * The `role:'tool'` message that feeds a tool result (or denial notice)
 * back to the model.
 */
export function toolResultToMessage(
  call: McpPendingToolCall,
  resultText: string,
): OpenAI.Chat.Completions.ChatCompletionToolMessageParam {
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: resultText,
  };
}

export const DENIED_TOOL_RESULT = 'The user declined this tool call.';

/**
 * Reconstructs the assistant message that requested the pending calls, for
 * the resume round. The persisted transcript ends with the assistant's
 * round-1 TEXT; a legal chat.completions transcript needs that same message
 * to carry the `tool_calls` — so the loop replaces the trailing assistant
 * message with this one.
 */
export function pendingCallsToAssistantMessage(
  pending: Array<
    Pick<McpPendingToolCall, 'id'> & {
      modelToolName: string;
      argumentsJson: string;
    }
  >,
  assistantText: string | null,
): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
  return {
    role: 'assistant',
    ...(assistantText ? { content: assistantText } : { content: null }),
    tool_calls: pending.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: {
        name: call.modelToolName,
        arguments: call.argumentsJson,
      },
    })),
  };
}

/** Assembled call (accumulator output) → wire-shape pending call. */
export function assembledCallToPending(
  call: AssembledToolCall,
  serverId: string,
  toolName: string,
): McpPendingToolCall {
  return {
    id: call.id,
    serverId,
    toolName,
    argumentsJson: call.argumentsJson,
  };
}
