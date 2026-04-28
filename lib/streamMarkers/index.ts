/**
 * Stream marker protocol — single source of truth for the structured
 * sentinel tags we embed inline in chat response streams.
 *
 * The chat backend forwards model output (text deltas) interleaved with
 * its own structured events (consent prompts, agent activity updates).
 * Rather than reframing every chunk into SSE, we emit each event as a
 * sentinel-wrapped JSON payload in the same text stream. The client
 * extracts these markers and renders them, leaving the surrounding text
 * untouched for the markdown renderer.
 *
 * Why a module: the open/close strings used to be duplicated as string
 * literals across the handler, parser, and AssistantMessage component.
 * One typo and a marker silently disappears. Defining them once makes
 * the contract explicit and gives us a place to add escaping or escape
 * sequences if a future model legitimately outputs the literal sentinel.
 *
 * Marker shape:
 *   <<<KIND>>>{json-payload}<<<END_KIND>>>
 *
 * Wrapped in `\n\n` on each side so they don't break paragraphs in the
 * markdown renderer when they slip through stripping (defense-in-depth).
 */

// ───────────────────────────────────────────────────────────────────
// Marker tag literals — exported so test fixtures can reference them
// without duplicating the string.
// ───────────────────────────────────────────────────────────────────
export const AGENT_ACTIVITY_OPEN = '<<<AGENT_ACTIVITY>>>';
export const AGENT_ACTIVITY_CLOSE = '<<<END_AGENT_ACTIVITY>>>';
export const CONSENT_REQUEST_OPEN = '<<<CONSENT_REQUEST>>>';
export const CONSENT_REQUEST_CLOSE = '<<<END_CONSENT_REQUEST>>>';

// ───────────────────────────────────────────────────────────────────
// Payload shapes
// ───────────────────────────────────────────────────────────────────

/**
 * Transient activity update — drives the chat loader text. Only the
 * latest one in the stream is shown; previous ones are stripped.
 *
 * `key` is a translation key from `messages/en.json#chat.activity.*`.
 */
export interface AgentActivityPayload {
  key: string;
}

/**
 * Persistent consent / approval prompt. The client renders these as
 * inline cards in the assistant message.
 */
export type ConsentRequestPayload =
  | {
      kind: 'oauth';
      consent_url: string;
      server_label?: string | null;
    }
  | {
      kind: 'approval';
      approval_request_id: string;
      server_label?: string | null;
      tool_name?: string | null;
    };

// ───────────────────────────────────────────────────────────────────
// Emit helpers (server-side)
// ───────────────────────────────────────────────────────────────────

export function emitAgentActivity(key: string): string {
  return `\n\n${AGENT_ACTIVITY_OPEN}${JSON.stringify({ key })}${AGENT_ACTIVITY_CLOSE}\n\n`;
}

export function emitConsentRequest(payload: ConsentRequestPayload): string {
  return `\n\n${CONSENT_REQUEST_OPEN}${JSON.stringify(payload)}${CONSENT_REQUEST_CLOSE}\n\n`;
}

// ───────────────────────────────────────────────────────────────────
// Parse helpers (client-side)
// ───────────────────────────────────────────────────────────────────

const AGENT_ACTIVITY_RE =
  /<<<AGENT_ACTIVITY>>>([\s\S]*?)<<<END_AGENT_ACTIVITY>>>/g;
const AGENT_ACTIVITY_STRIP_RE =
  /\n*<<<AGENT_ACTIVITY>>>[\s\S]*?<<<END_AGENT_ACTIVITY>>>\n*/g;

const CONSENT_REQUEST_RE =
  /<<<CONSENT_REQUEST>>>([\s\S]*?)<<<END_CONSENT_REQUEST>>>/g;

/**
 * Pulls the latest `AGENT_ACTIVITY` payload out of the stream content
 * and returns a cleaned copy with all activity markers removed.
 *
 * Multiple markers may appear (one per emit); only the most recent one
 * matters because the loader shows a single message at a time.
 */
export function extractLatestAgentActivity(content: string): {
  latest: AgentActivityPayload | null;
  cleaned: string;
} {
  const matches = [...content.matchAll(AGENT_ACTIVITY_RE)];
  let latest: AgentActivityPayload | null = null;
  if (matches.length > 0) {
    const lastJson = matches[matches.length - 1][1];
    try {
      const parsed = JSON.parse(lastJson);
      if (parsed && typeof parsed.key === 'string') {
        latest = { key: parsed.key };
      }
    } catch {
      // ignore malformed payload
    }
  }
  const cleaned =
    matches.length > 0 ? content.replace(AGENT_ACTIVITY_STRIP_RE, '') : content;
  return { latest, cleaned };
}

/**
 * Pulls all `CONSENT_REQUEST` payloads out of the stream content and
 * returns a cleaned copy with all consent markers removed. Caller is
 * responsible for any UI-level deduplication (e.g. by consent_url).
 */
export function extractConsentRequests(content: string): {
  requests: ConsentRequestPayload[];
  cleaned: string;
} {
  const requests: ConsentRequestPayload[] = [];
  const cleaned = content.replace(CONSENT_REQUEST_RE, (_match, json) => {
    try {
      const parsed = JSON.parse(json);
      if (parsed && (parsed.kind === 'oauth' || parsed.kind === 'approval')) {
        requests.push(parsed as ConsentRequestPayload);
      }
    } catch {
      // ignore malformed payload
    }
    return '';
  });
  return { requests, cleaned };
}

/**
 * Hides partially-streamed sentinel markers from the rendered text. When
 * the open tag has arrived but the close tag hasn't yet, slice everything
 * from the open onward off the displayed content. The next render (after
 * the close tag arrives) regex-matches the full marker and renders it.
 *
 * Same pattern Streamdown uses for citation markers — buffer until the
 * marker is complete so users never see raw sentinel tokens.
 */
const MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [CONSENT_REQUEST_OPEN, CONSENT_REQUEST_CLOSE],
  [AGENT_ACTIVITY_OPEN, AGENT_ACTIVITY_CLOSE],
];

export function stripIncompleteStreamMarkers(content: string): string {
  let result = content;
  for (const [open, close] of MARKER_PAIRS) {
    const startIdx = result.indexOf(open);
    if (startIdx >= 0 && result.indexOf(close, startIdx) === -1) {
      result = result.slice(0, startIdx);
    }
  }
  return result;
}
