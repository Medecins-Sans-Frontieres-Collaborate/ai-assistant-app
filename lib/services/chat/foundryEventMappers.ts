import { emitAgentActivity, emitConsentRequest } from '@/lib/streamMarkers';

/**
 * Pure mappers from Foundry Responses-API stream events to our internal
 * AGENT_ACTIVITY / CONSENT_REQUEST sentinel markers. Extracted from
 * AIFoundryAgentHandler so the event → marker logic can be unit-tested
 * without spinning up the full handler + Azure SDK.
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
    return emitConsentRequest({
      kind: 'approval',
      approval_request_id: item.id,
      server_label: (item.server_label as string | null | undefined) ?? null,
      tool_name: (item.name as string | null | undefined) ?? null,
    });
  }

  if (item.type === 'mcp_call') {
    // MCP tool calls produce a transient "Calling tool…" / "Calling
    // {service}…" loader update rather than a persistent card.
    return emitAgentActivity(
      item.server_label
        ? 'chat.activity.callingService'
        : 'chat.activity.callingTool',
    );
  }

  return null;
}
