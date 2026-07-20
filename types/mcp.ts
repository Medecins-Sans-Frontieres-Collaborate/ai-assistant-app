/**
 * Shared wire types for native MCP (Model Context Protocol) support.
 *
 * These shapes travel in the /api/chat and /api/mcp/tools request bodies.
 * They deliberately exclude everything server-resolved (catalog URLs,
 * transports) so a tampered client payload can't redirect a token — see
 * resolveMcpServers in config/mcpCatalog.ts.
 */

/** Client-stable id: also used as the tool-name prefix sent to the model. */
export const MCP_SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * One MCP server entry as sent by the client with a chat request.
 *
 * For curated servers `catalogKey` is set and `url` is ignored server-side
 * (the catalog is authoritative). For arbitrary servers `url` is required
 * and must be https; the server additionally gates these behind
 * MCP_CUSTOM_SERVERS_ENABLED and an SSRF guard.
 *
 * `authToken` is the user's credential (PAT or OAuth access token). It
 * lives on-device (in-memory + the encrypted credential vault), rides only
 * in request bodies, and is used in-memory server-side — never persisted or
 * logged.
 */
export interface McpServerRequestEntry {
  id: string;
  name: string;
  catalogKey?: string;
  /**
   * Admin-authored connector id (`connector-<hex>`). Like `catalogKey`, the
   * url/transport/auth are resolved server-side and any client-sent `url` is
   * ignored — but unlike the catalog, the resolution ALSO evaluates this
   * user's access rules and fails closed. A client holding a stale entry for
   * a connector it is no longer entitled to gets nothing back.
   */
  connectorId?: string;
  url?: string;
  authToken?: string;
}

/**
 * A tool call the model requested in a previous round, echoed back by the
 * client together with the user's approvalResponses so the (stateless)
 * server can reconstruct the transcript and execute approved calls.
 *
 * NOTE: this round-trips through the client and is therefore user-tamperable.
 * That is acceptable by design — the user is the principal (their token,
 * their consent, their MCP server) — but the server still size-caps and
 * JSON-parses `argumentsJson` defensively.
 */
export interface McpPendingToolCall {
  /**
   * Provider tool-call id (`call_…` for OpenAI, `toolu_…` for Anthropic),
   * doubles as approval_request_id. Opaque end-to-end.
   */
  id: string;
  /** McpServerRequestEntry.id of the server that owns the tool. */
  serverId: string;
  /** Raw MCP tool name (no server prefix). */
  toolName: string;
  /** Arguments exactly as the model emitted them. */
  argumentsJson: string;
}

/** Tool definition as returned by /api/mcp/tools for the settings UI. */
export interface McpToolSummary {
  name: string;
  description?: string;
}
