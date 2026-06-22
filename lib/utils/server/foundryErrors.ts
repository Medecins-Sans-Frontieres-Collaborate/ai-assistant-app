/**
 * Helpers for parsing Azure AI Foundry / Responses-API error shapes.
 *
 * The Foundry SDK throws errors with a few different shapes depending on
 * which layer fails (HTTP, ARM, the OpenAI-compatible response API). These
 * helpers normalize the parts we care about.
 */

/**
 * Upper bound on how many approval ids we'll extract from a single error.
 * Independent of the request-side `InputValidator` approvals cap (`.max(16)`)
 * and deliberately a bit higher: Foundry may list more pending approvals in one
 * error than a single client request submitted. A hostile or misshapen gateway
 * error is capped here so we never enqueue an unbounded batch of
 * `mcp_approval_response` items in the auto-deny retry path.
 */
const MAX_EXTRACTED_IDS = 32;

/**
 * Detects Foundry's "pending mcp_approval_requests" 400 and returns the
 * `approval_request_id`s it lists. Foundry returns:
 *   "400 The following MCP approval requests do not have an approval:
 *    mcpr_xxx, mcpr_yyy"
 * Returns an empty array for any other error so the caller can re-throw.
 * Caps the result at `MAX_EXTRACTED_IDS` distinct ids.
 */
export function extractPendingApprovalIds(err: any): string[] {
  const status = err?.statusCode || err?.status || err?.response?.status;
  if (status !== 400) return [];
  const sources = [
    err?.message,
    err?.error?.message,
    err?.response?.body,
    typeof err?.body === 'string' ? err.body : undefined,
  ].filter((s): s is string => typeof s === 'string');
  for (const source of sources) {
    if (!source.includes('do not have an approval')) continue;
    const matches = source.match(/mcpr_[a-zA-Z0-9_-]+/g);
    if (matches && matches.length > 0) {
      return Array.from(new Set(matches)).slice(0, MAX_EXTRACTED_IDS);
    }
  }
  return [];
}
