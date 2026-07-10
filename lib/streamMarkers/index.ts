/**
 * Stream event protocol. Structured events embedded inline in chat
 * response streams.
 *
 * Wire shape: `\n\n<<<KIND>>>{json}<<<END_KIND>>>\n\n`
 *
 * Two parsers consume this format:
 *   - `scanStreamEvents` is forward-only and used by `StreamParser` on the
 *     streaming hot path (O(chunk_size) per call).
 *   - The single-shot `extract*` helpers below scan a full content string.
 *     Used for reload of persisted message content and test fixtures.
 */

// ───────────────────────────────────────────────────────────────────
// Marker tag literals — exported so test fixtures can reference them
// without duplicating the string.
// ───────────────────────────────────────────────────────────────────
export const AGENT_ACTIVITY_OPEN = '<<<AGENT_ACTIVITY>>>';
export const AGENT_ACTIVITY_CLOSE = '<<<END_AGENT_ACTIVITY>>>';
export const CONSENT_REQUEST_OPEN = '<<<CONSENT_REQUEST>>>';
export const CONSENT_REQUEST_CLOSE = '<<<END_CONSENT_REQUEST>>>';
export const CONSENT_OUTCOME_OPEN = '<<<CONSENT_OUTCOME>>>';
export const CONSENT_OUTCOME_CLOSE = '<<<END_CONSENT_OUTCOME>>>';
export const TOOL_CALL_RECORD_OPEN = '<<<TOOL_CALL_RECORD>>>';
export const TOOL_CALL_RECORD_CLOSE = '<<<END_TOOL_CALL_RECORD>>>';
export const WORKFLOW_EVENT_OPEN = '<<<WORKFLOW_EVENT>>>';
export const WORKFLOW_EVENT_CLOSE = '<<<END_WORKFLOW_EVENT>>>';

// ───────────────────────────────────────────────────────────────────
// Payload shapes
// ───────────────────────────────────────────────────────────────────

/**
 * Transient activity update — drives the chat loader text. Only the
 * latest one in the stream is shown; previous ones are stripped.
 *
 * `key` is a translation key from `messages/en.json#chat.activity.*`.
 * `params` is optional interpolation data for the translation (e.g.
 * `{ tool: 'get_invoice' }` so the loader can say "Using get_invoice").
 */
export interface AgentActivityPayload {
  key: string;
  params?: Record<string, string>;
}

/**
 * Persistent record of an MCP tool call that ran during this turn. Emitted
 * when Foundry's `output_item.done` fires for an `mcp_call` item, so the
 * client can render a "Used N tools" summary below the assistant message
 * (and surface tool errors that would otherwise be invisible).
 */
export interface ToolCallRecordPayload {
  id: string;
  name: string;
  server_label: string | null;
  /** JSON-serialized arguments the tool was called with. Display only. */
  arguments: string | null;
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress';
  /** Raw output returned by the tool, if Foundry surfaced it on the item. */
  output: string | null;
  /** Error message if the tool call failed. */
  error: string | null;
  /**
   * Failure classification (native MCP loop): 'auth' = the MCP server
   * rejected our credential — the client flips the connector to
   * needs-reauth and the UI offers "Reconnect". Absent on success and on
   * non-auth failures. Additive; older persisted records simply lack it.
   */
  error_kind?: 'auth';
  /**
   * Native-MCP server id (McpServerConfig.id) so the client can map an
   * auth failure back to the connector config. Absent on Foundry records.
   */
  server_id?: string | null;
  /** Wall-clock duration in milliseconds, if we observed both start + end. */
  duration_ms?: number;
  /** Whether this call required user approval, and if so, how it resolved. */
  approval_request_id?: string | null;
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
      /**
       * McpServerConfig.id of the native-MCP server that owns the tool.
       * Absent on Foundry-agent approvals (Foundry dispatches those itself);
       * present on native MCP tool-loop approvals so the client can echo
       * back `mcpPendingToolCalls` on resume.
       */
      server_id?: string | null;
      tool_name?: string | null;
      /**
       * JSON-serialized arguments the tool will be invoked with, as Foundry
       * emits them on the `mcp_approval_request` item. Pre-rendered for
       * display; the client should NOT use this for dispatch.
       */
      tool_arguments?: string | null;
    };

/**
 * Server-side resolution of a consent prompt — used when the server auto-
 * denies pending approvals (e.g. user sent a new message instead of acting
 * on the card). The client records this so the affected card's UI flips
 * out of "pending" without waiting for a reload.
 */
export interface ConsentOutcomePayload {
  approval_request_id: string;
  approve: boolean;
}

/**
 * Structured result from a workflow run (conversation workflows:
 * translation, document, data-analysis, map). Unlike AGENT_ACTIVITY these
 * are not transient loader text — they carry results (analysis findings,
 * review-round verdicts, transformed tables, map features) that the
 * workflow workspace applies to its persisted state.
 *
 * `workflow` names the emitting workflow; `type` is a workflow-scoped
 * event name (e.g. 'analysis', 'review_round', 'features'); `data` is the
 * event body, typed by the workflow's own module.
 */
export interface WorkflowEventPayload {
  workflow: 'translation' | 'document' | 'data-analysis' | 'map';
  type: string;
  data: unknown;
}

// ───────────────────────────────────────────────────────────────────
// Emit helpers (server-side)
// ───────────────────────────────────────────────────────────────────

export function emitAgentActivity(
  key: string,
  params?: Record<string, string>,
): string {
  const payload: AgentActivityPayload = params ? { key, params } : { key };
  return `\n\n${AGENT_ACTIVITY_OPEN}${JSON.stringify(payload)}${AGENT_ACTIVITY_CLOSE}\n\n`;
}

export function emitConsentRequest(payload: ConsentRequestPayload): string {
  return `\n\n${CONSENT_REQUEST_OPEN}${JSON.stringify(payload)}${CONSENT_REQUEST_CLOSE}\n\n`;
}

export function emitConsentOutcome(payload: ConsentOutcomePayload): string {
  return `\n\n${CONSENT_OUTCOME_OPEN}${JSON.stringify(payload)}${CONSENT_OUTCOME_CLOSE}\n\n`;
}

export function emitToolCallRecord(payload: ToolCallRecordPayload): string {
  return `\n\n${TOOL_CALL_RECORD_OPEN}${JSON.stringify(payload)}${TOOL_CALL_RECORD_CLOSE}\n\n`;
}

export function emitWorkflowEvent(payload: WorkflowEventPayload): string {
  return `\n\n${WORKFLOW_EVENT_OPEN}${JSON.stringify(payload)}${WORKFLOW_EVENT_CLOSE}\n\n`;
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

const CONSENT_OUTCOME_RE =
  /<<<CONSENT_OUTCOME>>>([\s\S]*?)<<<END_CONSENT_OUTCOME>>>/g;
const CONSENT_OUTCOME_STRIP_RE =
  /\n*<<<CONSENT_OUTCOME>>>[\s\S]*?<<<END_CONSENT_OUTCOME>>>\n*/g;

const TOOL_CALL_RECORD_RE =
  /<<<TOOL_CALL_RECORD>>>([\s\S]*?)<<<END_TOOL_CALL_RECORD>>>/g;

const WORKFLOW_EVENT_RE =
  /<<<WORKFLOW_EVENT>>>([\s\S]*?)<<<END_WORKFLOW_EVENT>>>/g;

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
        if (
          parsed.params &&
          typeof parsed.params === 'object' &&
          !Array.isArray(parsed.params)
        ) {
          // Coerce all param values to string so the renderer can hand them
          // to next-intl without runtime type errors.
          const safeParams: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed.params)) {
            if (v != null) safeParams[k] = String(v);
          }
          if (Object.keys(safeParams).length > 0) {
            latest.params = safeParams;
          }
        }
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
 * Pulls every `CONSENT_OUTCOME` payload from the content and returns a
 * cleaned copy with all outcome markers removed. Outcomes are side-effect
 * only — they trigger client-side state updates and never render.
 */
export function extractConsentOutcomes(content: string): {
  outcomes: ConsentOutcomePayload[];
  cleaned: string;
} {
  const outcomes: ConsentOutcomePayload[] = [];
  let cleaned = content;
  cleaned = cleaned.replace(CONSENT_OUTCOME_RE, (_match, json) => {
    try {
      const parsed = JSON.parse(json);
      if (
        parsed &&
        typeof parsed.approval_request_id === 'string' &&
        typeof parsed.approve === 'boolean'
      ) {
        outcomes.push(parsed as ConsentOutcomePayload);
      }
    } catch {
      // ignore malformed payload
    }
    return '';
  });
  // Belt-and-suspenders: also strip via the dedicated regex in case the
  // payload-parse path missed a malformed marker.
  cleaned = cleaned.replace(CONSENT_OUTCOME_STRIP_RE, '');
  return { outcomes, cleaned };
}

/**
 * Pulls every `TOOL_CALL_RECORD` payload from content and returns it
 * stripped. Records are display-only metadata for the tool usage summary;
 * they never appear inline in the rendered markdown.
 */
export function extractToolCallRecords(content: string): {
  records: ToolCallRecordPayload[];
  cleaned: string;
} {
  const records: ToolCallRecordPayload[] = [];
  const cleaned = content.replace(TOOL_CALL_RECORD_RE, (_match, json) => {
    try {
      const parsed = JSON.parse(json);
      if (
        parsed &&
        typeof parsed.id === 'string' &&
        typeof parsed.name === 'string' &&
        typeof parsed.status === 'string'
      ) {
        records.push(parsed as ToolCallRecordPayload);
      }
    } catch {
      // ignore malformed payload
    }
    return '';
  });
  return { records, cleaned };
}

function isWorkflowEventPayload(value: unknown): value is WorkflowEventPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as { workflow?: unknown; type?: unknown };
  return (
    (p.workflow === 'translation' ||
      p.workflow === 'document' ||
      p.workflow === 'data-analysis' ||
      p.workflow === 'map') &&
    typeof p.type === 'string'
  );
}

/**
 * Pulls every `WORKFLOW_EVENT` payload from content and returns it
 * stripped. Used for reload of persisted message content; the streaming
 * hot path consumes these via `scanStreamEvents`.
 */
export function extractWorkflowEvents(content: string): {
  events: WorkflowEventPayload[];
  cleaned: string;
} {
  const events: WorkflowEventPayload[] = [];
  const cleaned = content.replace(WORKFLOW_EVENT_RE, (_match, json) => {
    try {
      const parsed = JSON.parse(json);
      if (isWorkflowEventPayload(parsed)) {
        events.push(parsed);
      }
    } catch {
      // ignore malformed payload
    }
    return '';
  });
  return { events, cleaned };
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
  [CONSENT_OUTCOME_OPEN, CONSENT_OUTCOME_CLOSE],
  [AGENT_ACTIVITY_OPEN, AGENT_ACTIVITY_CLOSE],
  [TOOL_CALL_RECORD_OPEN, TOOL_CALL_RECORD_CLOSE],
  [WORKFLOW_EVENT_OPEN, WORKFLOW_EVENT_CLOSE],
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

// ───────────────────────────────────────────────────────────────────
// Forward-only single-pass parser (the streaming hot path)
// ───────────────────────────────────────────────────────────────────

/** Structured event lifted out of the stream. Text deltas return separately. */
export type StreamEvent =
  | { type: 'agent_activity'; payload: AgentActivityPayload }
  | { type: 'consent_request'; payload: ConsentRequestPayload }
  | { type: 'consent_outcome'; payload: ConsentOutcomePayload }
  | { type: 'tool_call_record'; payload: ToolCallRecordPayload }
  | { type: 'workflow_event'; payload: WorkflowEventPayload };

export interface StreamScanResult {
  /** Events consumed in this scan, in arrival order. */
  events: StreamEvent[];
  /** Display text consumed in this scan (text between events, no markers). */
  displayDelta: string;
  /** Index in the input text up to which we've consumed. */
  nextIndex: number;
}

interface MarkerSpec {
  open: string;
  close: string;
  type: StreamEvent['type'];
}

const MARKERS: readonly MarkerSpec[] = [
  {
    open: AGENT_ACTIVITY_OPEN,
    close: AGENT_ACTIVITY_CLOSE,
    type: 'agent_activity',
  },
  {
    open: CONSENT_REQUEST_OPEN,
    close: CONSENT_REQUEST_CLOSE,
    type: 'consent_request',
  },
  {
    open: CONSENT_OUTCOME_OPEN,
    close: CONSENT_OUTCOME_CLOSE,
    type: 'consent_outcome',
  },
  {
    open: TOOL_CALL_RECORD_OPEN,
    close: TOOL_CALL_RECORD_CLOSE,
    type: 'tool_call_record',
  },
  {
    open: WORKFLOW_EVENT_OPEN,
    close: WORKFLOW_EVENT_CLOSE,
    type: 'workflow_event',
  },
];

function findNextMarker(
  text: string,
  fromIndex: number,
): { start: number; spec: MarkerSpec } | null {
  let best: { start: number; spec: MarkerSpec } | null = null;
  for (const spec of MARKERS) {
    const idx = text.indexOf(spec.open, fromIndex);
    if (idx === -1) continue;
    if (best === null || idx < best.start) {
      best = { start: idx, spec };
    }
  }
  return best;
}

/**
 * Returns the index (>= fromIndex) at which `text` ends with a non-empty
 * *proper prefix* of some marker's open tag — i.e. a marker open that was split
 * across a chunk boundary (e.g. a chunk ending in "<<<AGENT_ACTI"). Returns -1
 * when the tail can't be the start of any marker. A full open tag is excluded
 * (findNextMarker already finds those), so we only need prefixes up to
 * `open.length - 1`. Callers hold this tail back so the next chunk can complete
 * the marker instead of leaking the fragment into display text and losing the
 * event.
 */
function partialOpenStart(text: string, fromIndex: number): number {
  let earliest = -1;
  for (const spec of MARKERS) {
    const open = spec.open;
    const maxLen = Math.min(open.length - 1, text.length - fromIndex);
    for (let k = maxLen; k >= 1; k--) {
      const startIdx = text.length - k;
      if (startIdx < fromIndex) continue;
      if (text.startsWith(open.slice(0, k), startIdx)) {
        if (earliest === -1 || startIdx < earliest) earliest = startIdx;
        break; // longest prefix for this spec found
      }
    }
  }
  return earliest;
}

function parseEventPayload(spec: MarkerSpec, json: string): StreamEvent | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    switch (spec.type) {
      case 'agent_activity': {
        const p = parsed as { key?: unknown; params?: unknown };
        if (typeof p.key !== 'string') return null;
        const payload: AgentActivityPayload = { key: p.key };
        if (
          p.params &&
          typeof p.params === 'object' &&
          !Array.isArray(p.params)
        ) {
          const safeParams: Record<string, string> = {};
          for (const [k, v] of Object.entries(
            p.params as Record<string, unknown>,
          )) {
            if (v != null) safeParams[k] = String(v);
          }
          if (Object.keys(safeParams).length > 0) {
            payload.params = safeParams;
          }
        }
        return { type: 'agent_activity', payload };
      }
      case 'consent_request': {
        const p = parsed as { kind?: unknown };
        if (p.kind !== 'oauth' && p.kind !== 'approval') return null;
        return {
          type: 'consent_request',
          payload: parsed as ConsentRequestPayload,
        };
      }
      case 'consent_outcome': {
        const p = parsed as {
          approval_request_id?: unknown;
          approve?: unknown;
        };
        if (
          typeof p.approval_request_id !== 'string' ||
          typeof p.approve !== 'boolean'
        ) {
          return null;
        }
        return {
          type: 'consent_outcome',
          payload: parsed as ConsentOutcomePayload,
        };
      }
      case 'tool_call_record': {
        const p = parsed as { id?: unknown; name?: unknown; status?: unknown };
        if (
          typeof p.id !== 'string' ||
          typeof p.name !== 'string' ||
          typeof p.status !== 'string'
        ) {
          return null;
        }
        return {
          type: 'tool_call_record',
          payload: parsed as ToolCallRecordPayload,
        };
      }
      case 'workflow_event': {
        if (!isWorkflowEventPayload(parsed)) return null;
        return { type: 'workflow_event', payload: parsed };
      }
    }
  } catch {
    // ignore malformed payload — drop the event, advance past the marker
  }
  return null;
}

/**
 * Forward-only scan from `fromIndex` to end of input. Returns events,
 * display text between them, and the new cursor position. Incomplete
 * markers (open tag, no close yet) leave the cursor at the marker start
 * so the next call finishes the parse once the tail arrives.
 */
export function scanStreamEvents(
  input: string,
  fromIndex: number,
): StreamScanResult {
  const events: StreamEvent[] = [];
  let cursor = fromIndex;
  let displayDelta = '';

  while (cursor < input.length) {
    const next = findNextMarker(input, cursor);
    if (next === null) {
      // No complete marker visible. The tail might still be the *start* of one
      // split across the chunk boundary (e.g. ends with "<<<AGENT_ACTI"). Hold
      // that partial open back — flush only the text before it — so the next
      // scan completes the marker once the rest arrives. Without this the
      // fragment leaks into display text and its event is dropped permanently
      // (processedIndex is monotonic). Symmetric to the incomplete-close case.
      const partial = partialOpenStart(input, cursor);
      if (partial === -1) {
        displayDelta += input.slice(cursor);
        cursor = input.length;
      } else {
        displayDelta += input.slice(cursor, partial);
        cursor = partial;
      }
      break;
    }

    // Anything between cursor and the marker start is plain text.
    if (next.start > cursor) {
      displayDelta += input.slice(cursor, next.start);
    }

    const closeIdx = input.indexOf(
      next.spec.close,
      next.start + next.spec.open.length,
    );
    if (closeIdx === -1) {
      // Incomplete marker — leave the cursor at the marker start so the
      // next scan finishes the parse after more bytes arrive.
      cursor = next.start;
      break;
    }

    const payloadStart = next.start + next.spec.open.length;
    const payloadJson = input.slice(payloadStart, closeIdx);
    const event = parseEventPayload(next.spec, payloadJson);
    if (event !== null) {
      events.push(event);
    }
    cursor = closeIdx + next.spec.close.length;
  }

  return { events, displayDelta, nextIndex: cursor };
}
