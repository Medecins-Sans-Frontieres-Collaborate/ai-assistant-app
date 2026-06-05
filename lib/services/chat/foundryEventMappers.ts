import {
  ToolCallRecordPayload,
  emitAgentActivity,
  emitConsentRequest,
  emitToolCallRecord,
} from '@/lib/streamMarkers';

/**
 * Pure mappers from Foundry Responses-API stream events to our internal
 * AGENT_ACTIVITY / CONSENT_REQUEST / TOOL_CALL_RECORD sentinel markers.
 * Extracted from AIFoundryAgentHandler so the event → marker logic can be
 * unit-tested without spinning up the full handler + Azure SDK.
 *
 * Event shapes are documented at
 *   https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/mcp-authentication
 *   https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol
 */

/**
 * Maps a Foundry stream event type to the translation key the chat loader
 * should display while that event is in progress. Returns null for events
 * that don't map to a user-visible activity (lifecycle, completion, etc.).
 */
export function activityKeyForEvent(type: string | undefined): string | null {
  switch (type) {
    case 'response.web_search_call.in_progress':
    case 'response.web_search_call.searching':
      return 'chat.activity.searchingWeb';
    case 'response.file_search_call.in_progress':
    case 'response.file_search_call.searching':
      return 'chat.activity.searchingFiles';
    case 'response.code_interpreter_call.in_progress':
    case 'response.code_interpreter_call.interpreting':
      return 'chat.activity.runningCode';
    case 'response.image_generation_call.in_progress':
    case 'response.image_generation_call.generating':
      return 'chat.activity.generatingImage';
    case 'response.mcp_list_tools.in_progress':
      return 'chat.activity.listingTools';
    case 'response.mcp_call.in_progress':
      return 'chat.activity.callingTool';
    default:
      return null;
  }
}

/**
 * Maps a Foundry `output_item` payload to a marker string suitable for
 * enqueueing into the response stream. Returns null when the item type
 * isn't one we surface (text content, etc.) OR when required fields are
 * missing (e.g. an `oauth_consent_request` without a `consent_link`).
 *
 * The caller is responsible for deduping via item.id — this function
 * does not track state.
 */
export function outputItemToMarker(
  item: { id?: string; type?: string } & Record<string, unknown>,
): string | null {
  if (!item || !item.id) return null;

  if (
    item.type === 'oauth_consent_request' &&
    typeof item.consent_link === 'string' &&
    item.consent_link.length > 0
  ) {
    return emitConsentRequest({
      kind: 'oauth',
      consent_url: item.consent_link as string,
      server_label: (item.server_label as string | null | undefined) ?? null,
    });
  }

  if (item.type === 'mcp_approval_request') {
    // Foundry emits `arguments` as a JSON string on this item. We forward
    // it verbatim for display only — the agent has already constructed the
    // call and will execute it once the user approves.
    const rawArgs = item.arguments;
    const tool_arguments =
      typeof rawArgs === 'string'
        ? rawArgs
        : rawArgs != null
          ? JSON.stringify(rawArgs)
          : null;
    return emitConsentRequest({
      kind: 'approval',
      approval_request_id: item.id,
      server_label: (item.server_label as string | null | undefined) ?? null,
      tool_name: (item.name as string | null | undefined) ?? null,
      tool_arguments,
    });
  }

  if (item.type === 'mcp_call') {
    // MCP tool calls produce a transient activity loader update. When we
    // know the tool name (we do here), use a named variant so the loader
    // can say "Using {tool}…" rather than a generic "Calling tool…".
    const toolName = typeof item.name === 'string' ? item.name : null;
    const serverLabel =
      typeof item.server_label === 'string' ? item.server_label : null;
    if (toolName && serverLabel) {
      return emitAgentActivity('chat.activity.usingNamedToolWithService', {
        tool: toolName,
        service: serverLabel,
      });
    }
    if (toolName) {
      return emitAgentActivity('chat.activity.usingNamedTool', {
        tool: toolName,
      });
    }
    return emitAgentActivity(
      serverLabel
        ? 'chat.activity.callingService'
        : 'chat.activity.callingTool',
    );
  }

  return null;
}

/**
 * Maps a Foundry `output_item` payload to a persistent TOOL_CALL_RECORD
 * marker for the post-stream summary. Returns null for items that aren't
 * MCP calls. Caller dedupes via item.id.
 *
 * Foundry's `output_item.done` for an `mcp_call` item includes the final
 * `output`, `error`, and `status` fields — that's where this should be
 * called (not on `.added`, which fires before the call has run).
 */
export function mcpCallItemToRecord(
  item: { id?: string; type?: string } & Record<string, unknown>,
  options: { duration_ms?: number } = {},
): string | null {
  if (!item || !item.id || item.type !== 'mcp_call') return null;

  const rawArgs = item.arguments;
  const args =
    typeof rawArgs === 'string'
      ? rawArgs
      : rawArgs != null
        ? JSON.stringify(rawArgs)
        : null;

  // Status defaults to `completed` when Foundry omits it on success.
  const rawStatus = item.status;
  const status: ToolCallRecordPayload['status'] =
    rawStatus === 'failed' ||
    rawStatus === 'incomplete' ||
    rawStatus === 'in_progress' ||
    rawStatus === 'completed'
      ? rawStatus
      : typeof item.error === 'string' && item.error.length > 0
        ? 'failed'
        : 'completed';

  return emitToolCallRecord({
    id: item.id,
    name: typeof item.name === 'string' ? item.name : 'tool',
    server_label:
      typeof item.server_label === 'string' ? item.server_label : null,
    arguments: args,
    status,
    output: typeof item.output === 'string' ? item.output : null,
    error: typeof item.error === 'string' ? item.error : null,
    duration_ms: options.duration_ms,
    approval_request_id:
      typeof item.approval_request_id === 'string'
        ? item.approval_request_id
        : null,
  });
}
