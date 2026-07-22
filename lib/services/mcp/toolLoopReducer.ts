import { ApprovalResponse } from '@/types/chat';
import { McpPendingToolCall } from '@/types/mcp';

import { pendingCallsToAssistantMessage } from './mcpEventMappers';
import { toModelToolName } from './toolNameMapping';

import type OpenAI from 'openai';

/**
 * Pure logic for the tool loop's resume round: approval partitioning and
 * transcript reconstruction. Kept I/O-free because a malformed reconstructed
 * transcript 400s the whole turn at the provider — this is the riskiest part
 * of the stateless design and needs to be trivially unit-testable.
 */

export interface ApprovalPlan {
  approved: McpPendingToolCall[];
  denied: McpPendingToolCall[];
  /** No response arrived for these — auto-denied (mirrors the Foundry path). */
  autoDenied: McpPendingToolCall[];
}

export function partitionApprovals(
  pending: McpPendingToolCall[],
  approvals: ApprovalResponse[] | undefined,
): ApprovalPlan {
  const byId = new Map(
    (approvals ?? []).map((a) => [a.approval_request_id, a.approve]),
  );
  const plan: ApprovalPlan = { approved: [], denied: [], autoDenied: [] };
  for (const call of pending) {
    const decision = byId.get(call.id);
    if (decision === true) plan.approved.push(call);
    else if (decision === false) plan.denied.push(call);
    else plan.autoDenied.push(call);
  }
  return plan;
}

/** Extracts plain text from a prepared message's content for reconstruction. */
function contentText(
  content: OpenAI.Chat.Completions.ChatCompletionMessageParam['content'],
): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text ?? '')
          : '',
      )
      .join('');
    return text || null;
  }
  return null;
}

/**
 * Rebuilds a legal chat.completions transcript for the resume round.
 *
 * The persisted conversation ends with the assistant's round-1 TEXT (the
 * client saved what streamed before the pause). A legal transcript needs
 * that same assistant message to carry the `tool_calls`, so:
 * - trailing assistant message → REPLACED with text + tool_calls;
 * - anything else trailing → the tool_calls assistant message is appended.
 *
 * Every pending call gets exactly one `role:'tool'` follow-up appended by
 * the caller (result, error, or denial text) — a tool_calls message whose
 * ids lack tool results is itself an illegal transcript.
 */
export function reconstructTranscript(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  pending: McpPendingToolCall[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const withNames = pending.map((call) => ({
    id: call.id,
    modelToolName: toModelToolName(call.serverId, call.toolName),
    argumentsJson: call.argumentsJson,
  }));

  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    return [
      ...messages.slice(0, -1),
      pendingCallsToAssistantMessage(withNames, contentText(last.content)),
    ];
  }
  return [...messages, pendingCallsToAssistantMessage(withNames, null)];
}

/**
 * Defensive parse of model-emitted arguments JSON (which also round-trips
 * through the client). Returns null when unparseable — the caller surfaces
 * a failed tool call instead of throwing.
 */
export function parseToolArguments(
  argumentsJson: string,
): Record<string, unknown> | null {
  if (argumentsJson.length > 20_000) return null;
  try {
    const parsed: unknown = JSON.parse(argumentsJson || '{}');
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
