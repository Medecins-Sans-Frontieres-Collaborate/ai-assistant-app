import {
  M365_ALWAYS_CONFIRM_TOOLS,
  M365_BUILTIN_SERVER_ID,
} from '@/lib/services/m365/tools/toolCatalog';

/**
 * Global (cross-conversation) MCP tool approval rules.
 *
 * Layering: these rules are the USER-level policy, evaluated alongside the
 * per-conversation `alwaysApproveTools` / `alwaysApproveAllTools` fields.
 * A `reject` rule always wins — over global approvals AND over every
 * per-conversation auto-approve — because "never run this" is a safety
 * decision that a convenience toggle must not override.
 *
 * Rules can be created from a consent card ("always/never for this tool")
 * or hand-authored in Settings → Connectors for tools the user has not
 * encountered yet — which is why matching is by NAME, not by anything only
 * a live consent request would carry.
 */
export interface ToolApprovalRule {
  /** Client-generated; only used for list management in the settings UI. */
  id: string;
  /** Exact tool name (MCP tool identifiers are case-sensitive). */
  toolName: string;
  /**
   * Connector display label this rule is scoped to; undefined = any
   * connector. Matched case-insensitively on the trimmed label, since the
   * label is presentation data echoed back by stream markers.
   */
  serverLabel?: string;
  action: 'approve' | 'reject';
  createdAt: string;
}

function labelMatches(
  ruleLabel: string | undefined,
  requestLabel: string | null | undefined,
): boolean {
  if (!ruleLabel) return true;
  if (!requestLabel) return false;
  return ruleLabel.trim().toLowerCase() === requestLabel.trim().toLowerCase();
}

/**
 * Resolves the global policy for one tool-approval prompt. Returns null
 * when no rule matches (the prompt surfaces as usual). When both an
 * approve and a reject rule match the same call, reject wins.
 */
/**
 * First-party M365 write tools confirm on EVERY call (fourth-pass B3):
 * reject rules still win as usual, but approve rules and per-conversation
 * "always approve" preferences must be IGNORED for them — the consent card
 * with the concrete payload shows every time. Matches on the native-MCP
 * `server_id` plus the RAW (un-namespaced) tool name, exactly as carried by
 * the consent payload.
 */
export function isAlwaysConfirmTool(
  serverId: string | null | undefined,
  toolName: string | null | undefined,
): boolean {
  return (
    serverId === M365_BUILTIN_SERVER_ID &&
    !!toolName &&
    M365_ALWAYS_CONFIRM_TOOLS.has(toolName)
  );
}

export function evaluateToolApprovalRules(
  rules: ToolApprovalRule[],
  toolName: string | null | undefined,
  serverLabel: string | null | undefined,
): 'approve' | 'reject' | null {
  if (!toolName) return null;
  let decision: 'approve' | 'reject' | null = null;
  for (const rule of rules) {
    if (rule.toolName !== toolName) continue;
    if (!labelMatches(rule.serverLabel, serverLabel)) continue;
    if (rule.action === 'reject') return 'reject';
    decision = 'approve';
  }
  return decision;
}
