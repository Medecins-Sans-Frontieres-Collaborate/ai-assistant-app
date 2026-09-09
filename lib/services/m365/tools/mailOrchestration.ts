/**
 * Shared orchestration plumbing for the composite (agentic) mail tools
 * (fifth pass, docs/M365_FIFTH_PASS_MAIL_TOOLS_DESIGN.md). Everything here
 * is read-only: composites widen what enters the context, never what
 * leaves the mailbox.
 *
 * Binding execution rules implemented once here:
 * - ≤4 in-flight Graph requests per invocation (createCompositeRun's
 *   limiter). 429s honor Retry-After via targeted raw fetches (graphFetch
 *   collapses the status into an M365Error message, so the header would be
 *   lost) with a single retry.
 * - Hard caps: ≤500 envelopes scanned, ≤15 bodies fetched, ~30s wall
 *   clock per invocation. Expiry → callers return PARTIAL results with a
 *   prominent prefix, never a silent truncation.
 * - Every body passes screenMailMessage BEFORE it can reach a sub-model
 *   pass or tool output; flagged bodies are excluded from analysis and
 *   surfaced as flagged envelopes with reasons — never silently dropped.
 * - Utility-model (gpt-5-mini) passes are BATCHED (one call over many
 *   envelopes) with strict json_schema output carrying message ids +
 *   one-line reasons; any failure returns null and callers degrade to
 *   deterministic behavior — utility unavailability never fails a tool.
 * - Attachment content is never fetched — hasAttachments/metadata only.
 *
 * graphApi (and through it next-auth) is lazy-imported inside async
 * bodies, matching the rest of the toolset (see shared.ts rationale).
 * The utility OpenAI client replicates ServiceContainer's construction
 * (Foundry OpenAI-compatible endpoint, Entra-preferred fetch with the
 * static key as fallback) because the McpPlannerService seam — receiving
 * the client from StandardChatService — does not exist inside a tool.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { createLimiter } from '@/lib/services/m365/graphLimiter';
import type { M365ToolExecutionContext } from '@/lib/services/m365/tools/executor';
import {
  MailScreenInput,
  screenMailMessage,
} from '@/lib/services/m365/tools/mailScreen';
import {
  M365ToolInputError,
  isValidEmail,
  stripHtml,
  truncateText,
} from '@/lib/services/m365/tools/shared';

import type OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Budgets (shared execution rules — binding)
// ---------------------------------------------------------------------------

export const MAX_ENVELOPES_SCANNED = 500;
export const MAX_BODIES_FETCHED = 15;
export const MAX_CONCURRENT_GRAPH_REQUESTS = 4;
export const WALL_CLOCK_BUDGET_MS = 30_000;
export const PARTIAL_PREFIX = 'PARTIAL RESULTS (time budget reached): ';
/** Fallback backoff when a 429 carries no usable Retry-After. */
const THROTTLE_BACKOFF_MS = 2_000;
const MAX_RETRY_AFTER_MS = 10_000;
/** Graph $batch accepts at most 20 requests per call. */
const GRAPH_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Test hooks — fake clock / instant sleep / injected utility client
// ---------------------------------------------------------------------------

let nowFn: () => number = () => Date.now();
let sleepFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setNowFnForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function setSleepFnForTests(
  fn: ((ms: number) => Promise<void>) | null,
): void {
  sleepFn = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function nowMs(): number {
  return nowFn();
}

// ---------------------------------------------------------------------------
// Envelope shape (own helpers — mailReadTools is a concurrent agent's file)
// ---------------------------------------------------------------------------

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

/** Loose Graph message shape — only the fields composites read. */
export interface GraphCompositeMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: GraphRecipient;
  replyTo?: GraphRecipient[];
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  importance?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name?: string; value?: string }[];
}

export interface MailEnvelopeLite {
  id: string;
  /** Falls back to the message id when Graph omits conversationId. */
  conversationId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  /** receivedDateTime (or sentDateTime for Sent Items) as epoch ms. */
  receivedMs: number;
  receivedIso: string;
  preview: string;
  importance: 'low' | 'normal' | 'high';
  hasAttachments: boolean;
}

/** $select for envelope pulls — previews only, never bodies. */
export const ENVELOPE_SELECT =
  'id,conversationId,subject,from,toRecipients,ccRecipients,' +
  'receivedDateTime,sentDateTime,bodyPreview,importance,hasAttachments';

/** $select for body pulls (headers included for the phishing screen). */
export const BODY_SELECT =
  'id,conversationId,subject,from,replyTo,toRecipients,receivedDateTime,' +
  'sentDateTime,bodyPreview,importance,hasAttachments,body,' +
  'internetMessageHeaders';

function addresses(recipients: GraphRecipient[] | undefined): string[] {
  return (recipients ?? [])
    .map((r) => r.emailAddress?.address?.trim() ?? '')
    .filter(Boolean);
}

export function toEnvelopeLite(
  raw: GraphCompositeMessage | null | undefined,
): MailEnvelopeLite | null {
  if (!raw?.id) return null;
  const iso = raw.receivedDateTime ?? raw.sentDateTime ?? '';
  const parsed = Date.parse(iso);
  const importance =
    raw.importance === 'high' || raw.importance === 'low'
      ? raw.importance
      : 'normal';
  return {
    id: raw.id,
    conversationId: raw.conversationId ?? raw.id,
    subject: raw.subject?.trim() || '(no subject)',
    fromName: raw.from?.emailAddress?.name?.trim() ?? '',
    fromAddress: raw.from?.emailAddress?.address?.trim() ?? '',
    toAddresses: addresses(raw.toRecipients),
    ccAddresses: addresses(raw.ccRecipients),
    receivedMs: Number.isFinite(parsed) ? parsed : 0,
    receivedIso: iso,
    preview: raw.bodyPreview?.trim() ?? '',
    importance,
    hasAttachments: !!raw.hasAttachments,
  };
}

/** Keeps the newest envelope per conversation, newest-first overall. */
export function dedupeByConversation(
  envelopes: MailEnvelopeLite[],
): MailEnvelopeLite[] {
  const byConversation = new Map<string, MailEnvelopeLite>();
  for (const envelope of envelopes) {
    const existing = byConversation.get(envelope.conversationId);
    if (!existing || envelope.receivedMs > existing.receivedMs) {
      byConversation.set(envelope.conversationId, envelope);
    }
  }
  return Array.from(byConversation.values()).sort(
    (a, b) => b.receivedMs - a.receivedMs,
  );
}

export function formatEnvelopeRef(envelope: MailEnvelopeLite): string {
  const from = envelope.fromName || envelope.fromAddress || 'unknown sender';
  const date = envelope.receivedIso
    ? `${envelope.receivedIso.slice(0, 10)} ${envelope.receivedIso.slice(11, 16)}`
    : '?';
  return `"${envelope.subject}" — ${from} (${date}) [id: ${envelope.id}]`;
}

// ---------------------------------------------------------------------------
// Per-invocation run state: limiter + budgets + deadline
// ---------------------------------------------------------------------------

export interface CompositeRun {
  readonly req: NextRequest;
  readonly scopes: string[];
  /** Envelopes scanned so far (hard cap MAX_ENVELOPES_SCANNED). */
  scanned: number;
  /** Bodies fetched so far (hard cap MAX_BODIES_FETCHED). */
  bodiesFetched: number;
  /** True once the ~30s wall-clock budget has elapsed. */
  timedOut(): boolean;
  /** ≤4 in-flight Graph requests — every Graph call goes through here. */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
}

export function createCompositeRun(
  req: NextRequest,
  scopes: string[],
): CompositeRun {
  const startedAt = nowFn();
  return {
    req,
    scopes,
    scanned: 0,
    bodiesFetched: 0,
    timedOut: () => nowFn() - startedAt >= WALL_CLOCK_BUDGET_MS,
    schedule: createLimiter(MAX_CONCURRENT_GRAPH_REQUESTS),
  };
}

/** Prepends the prominent partial marker when the budget expired. */
export function finalizeResult(run: CompositeRun, text: string): string {
  return run.timedOut() ? `${PARTIAL_PREFIX}${text}` : text;
}

// ---------------------------------------------------------------------------
// Mailbox targeting (tier 3): only configured shared mailboxes
// ---------------------------------------------------------------------------

/**
 * '/me' for the user's own mailbox; '/users/{address}' only when the
 * address is one of the user's configured shared mailboxes
 * (case-insensitive) — anything else is an input error, per the design's
 * explicit-per-mailbox posture.
 */
export function resolveMailboxBase(
  ctx: M365ToolExecutionContext,
  mailbox: string | undefined,
): string {
  if (!mailbox) return '/me';
  if (!isValidEmail(mailbox)) {
    throw new M365ToolInputError('mailbox must be an email address');
  }
  const target = mailbox.toLowerCase();
  const configured = ctx.sharedMailboxes.find(
    (address) => address.toLowerCase() === target,
  );
  if (!configured) {
    throw new M365ToolInputError(
      `${mailbox} is not one of your configured shared mailboxes — add it under Settings → Connections first.`,
    );
  }
  return `/users/${encodeURIComponent(configured)}`;
}

// ---------------------------------------------------------------------------
// Graph access: raw fetch (Retry-After visible) + $batch + paged windows
// ---------------------------------------------------------------------------

/**
 * Single cached dynamic import of graphApi (lazy to keep next-auth out of
 * this module graph — see shared.ts). Cached because composites fan out
 * concurrent Graph calls: parallel `import()` of the same module must not
 * race (vitest's module mocker resolves concurrent first-imports of a
 * factory-mocked module inconsistently, and one import is cheaper anyway).
 */
let graphApiModulePromise: Promise<
  typeof import('@/lib/services/m365/graphApi')
> | null = null;

function graphApiModule(): Promise<
  typeof import('@/lib/services/m365/graphApi')
> {
  graphApiModulePromise ??= import('@/lib/services/m365/graphApi');
  return graphApiModulePromise;
}

function retryAfterMs(response: Response): number {
  const header = Number(response.headers.get('Retry-After'));
  return Number.isFinite(header) && header > 0
    ? Math.min(header * 1000, MAX_RETRY_AFTER_MS)
    : THROTTLE_BACKOFF_MS;
}

/**
 * Targeted raw Graph fetch via mintGraphToken: graphFetch collapses HTTP
 * status into the M365Error message, which loses the Retry-After header —
 * composites need it to honor throttling (429 → back off, retry once).
 */
export async function graphGetJson<T>(
  run: CompositeRun,
  path: string,
  options: { scopes?: string[]; init?: RequestInit } = {},
): Promise<T> {
  const { GRAPH_V1, M365Error, mintGraphToken } = await graphApiModule();
  return run.schedule(async () => {
    const token = await mintGraphToken(run.req, options.scopes ?? run.scopes);
    const url = path.startsWith('https://') ? path : `${GRAPH_V1}${path}`;
    const doFetch = () =>
      fetch(url, {
        ...options.init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.init?.headers ?? {}),
        },
      });
    let response = await doFetch();
    if (response.status === 429) {
      await sleepFn(retryAfterMs(response));
      response = await doFetch();
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const message =
        body?.error?.message || `Graph request failed (${response.status})`;
      if (response.status === 404) {
        throw new M365Error(message, 'not_found', 404);
      }
      if (response.status === 401 || response.status === 403) {
        throw new M365Error(message, 'forbidden', 403);
      }
      throw new M365Error(message, 'graph_error', 502);
    }
    return (await response.json()) as T;
  });
}

interface GraphBatchResponse {
  responses?: {
    id?: string;
    status?: number;
    body?: unknown;
  }[];
}

/**
 * $batch GET fan-in (20 requests per call) for per-message/per-conversation
 * lookups. Item-level 429s get one collective 2s-backoff retry; items that
 * still fail are omitted (callers treat missing ids as unfetchable).
 */
export async function graphBatchGet(
  run: CompositeRun,
  requests: { id: string; url: string }[],
): Promise<Map<string, unknown>> {
  const results = new Map<string, unknown>();
  for (let i = 0; i < requests.length; i += GRAPH_BATCH_SIZE) {
    if (run.timedOut()) break;
    let chunk = requests.slice(i, i + GRAPH_BATCH_SIZE);
    for (let attempt = 0; attempt < 2 && chunk.length > 0; attempt++) {
      if (attempt > 0) await sleepFn(THROTTLE_BACKOFF_MS);
      const data = await graphGetJson<GraphBatchResponse>(run, '/$batch', {
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: chunk.map((request) => ({
              id: request.id,
              method: 'GET',
              url: request.url,
            })),
          }),
        },
      });
      const throttled = new Set<string>();
      for (const item of data.responses ?? []) {
        if (!item.id) continue;
        if (item.status === 429) {
          throttled.add(item.id);
        } else if (
          typeof item.status === 'number' &&
          item.status >= 200 &&
          item.status < 300
        ) {
          results.set(item.id, item.body);
        }
      }
      chunk = chunk.filter((request) => throttled.has(request.id));
    }
  }
  return results;
}

export interface WindowFetchResult {
  envelopes: MailEnvelopeLite[];
  /** True when the 500-envelope scan cap cut the window short. */
  capReached: boolean;
}

/**
 * Paged envelope pull following @odata.nextLink, stopping at the per-call
 * max, the invocation-wide 500-envelope cap, or the wall clock — whichever
 * comes first. Plain paged GETs (not $batch): windows are single queries.
 */
export async function fetchWindowEnvelopes(
  run: CompositeRun,
  firstPath: string,
  maxEnvelopes: number = MAX_ENVELOPES_SCANNED,
): Promise<WindowFetchResult> {
  const envelopes: MailEnvelopeLite[] = [];
  let capReached = false;
  let path: string | null = firstPath;
  while (path && !run.timedOut()) {
    const data: {
      value?: GraphCompositeMessage[];
      '@odata.nextLink'?: string;
    } = await graphGetJson(run, path);
    for (const raw of data.value ?? []) {
      if (
        envelopes.length >= maxEnvelopes ||
        run.scanned >= MAX_ENVELOPES_SCANNED
      ) {
        capReached = true;
        break;
      }
      const lite = toEnvelopeLite(raw);
      if (lite) {
        envelopes.push(lite);
        run.scanned++;
      }
    }
    if (capReached) break;
    path = data['@odata.nextLink'] ?? null;
    if (
      path &&
      (envelopes.length >= maxEnvelopes || run.scanned >= MAX_ENVELOPES_SCANNED)
    ) {
      capReached = true;
      break;
    }
  }
  return { envelopes, capReached };
}

// ---------------------------------------------------------------------------
// Screened body access — the ONLY door a body may pass through
// ---------------------------------------------------------------------------

export interface ScreenedBody {
  id: string;
  conversationId: string;
  subject: string;
  from: string;
  receivedIso: string;
  bodyText: string;
  /** User explicitly overrode the flag — included but labeled flagged. */
  flaggedOverridden: boolean;
}

export interface FlaggedEnvelope {
  id: string;
  subject: string;
  from: string;
  receivedIso: string;
  reasons: string[];
}

/**
 * Screens already-fetched full messages. Every body passes
 * screenMailMessage before it can enter a sub-model pass or tool output;
 * suspicious bodies (unless user-overridden) are withheld and surfaced as
 * flagged envelopes with reasons.
 */
export async function screenGraphMessages(
  req: NextRequest,
  session: Session,
  ctx: M365ToolExecutionContext,
  messages: GraphCompositeMessage[],
): Promise<{ screened: ScreenedBody[]; flagged: FlaggedEnvelope[] }> {
  const screened: ScreenedBody[] = [];
  const flagged: FlaggedEnvelope[] = [];
  for (const raw of messages) {
    if (!raw.id) continue;
    const bodyText =
      raw.body?.contentType?.toLowerCase() === 'text'
        ? (raw.body?.content ?? '')
        : stripHtml(raw.body?.content ?? '');
    const input: MailScreenInput = {
      messageId: raw.id,
      bodyText,
      ...(raw.from?.emailAddress?.address && {
        from: raw.from.emailAddress.address,
      }),
      ...(raw.replyTo?.[0]?.emailAddress?.address && {
        replyTo: raw.replyTo[0].emailAddress.address,
      }),
      ...(raw.subject && { subject: raw.subject }),
      ...(raw.internetMessageHeaders && {
        headers: raw.internetMessageHeaders,
      }),
    };
    const verdict = await screenMailMessage(req, session, input, {
      overrideIds: ctx.screenOverrideIds,
    });
    const fromDisplay =
      raw.from?.emailAddress?.name || raw.from?.emailAddress?.address || '';
    const receivedIso = raw.receivedDateTime ?? raw.sentDateTime ?? '';
    if (verdict.verdict === 'suspicious' && !verdict.overridden) {
      flagged.push({
        id: raw.id,
        subject: raw.subject?.trim() || '(no subject)',
        from: fromDisplay,
        receivedIso,
        reasons: verdict.reasons,
      });
      continue;
    }
    screened.push({
      id: raw.id,
      conversationId: raw.conversationId ?? raw.id,
      subject: raw.subject?.trim() || '(no subject)',
      from: fromDisplay,
      receivedIso,
      bodyText,
      flaggedOverridden: verdict.verdict === 'suspicious',
    });
  }
  return { screened, flagged };
}

/**
 * Fetches full messages by id via $batch (respecting the ≤15 bodies cap)
 * and screens every one of them.
 */
export async function fetchScreenedBodies(
  run: CompositeRun,
  session: Session,
  ctx: M365ToolExecutionContext,
  base: string,
  ids: string[],
): Promise<{ screened: ScreenedBody[]; flagged: FlaggedEnvelope[] }> {
  const budget = Math.max(0, MAX_BODIES_FETCHED - run.bodiesFetched);
  const capped = ids.slice(0, budget);
  if (capped.length === 0) return { screened: [], flagged: [] };
  run.bodiesFetched += capped.length;
  const byId = await graphBatchGet(
    run,
    capped.map((id) => ({
      id,
      url: `${base}/messages/${encodeURIComponent(id)}?$select=${BODY_SELECT}`,
    })),
  );
  const messages = capped
    .map((id) => byId.get(id) as GraphCompositeMessage | undefined)
    .filter((message): message is GraphCompositeMessage => !!message?.id);
  return screenGraphMessages(run.req, session, ctx, messages);
}

/** Renders the never-silently-dropped flagged section. */
export function flaggedSummaryLines(flagged: FlaggedEnvelope[]): string[] {
  if (flagged.length === 0) return [];
  return [
    `${flagged.length} message${flagged.length === 1 ? '' : 's'} flagged as likely phishing/suspicious — excluded from analysis:`,
    ...flagged.map(
      (item) =>
        `- "${item.subject}" — ${item.from || 'unknown sender'} [id: ${item.id}] — flagged for: ${item.reasons.join('; ')}`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Utility model (gpt-5-mini) — batched, structured, best-effort
// ---------------------------------------------------------------------------

const UTILITY_MODEL = 'gpt-5-mini';
const UTILITY_BUDGET_MS = 12_000;
const UTILITY_MAX_COMPLETION_TOKENS = 1_500;

let utilityOverride: OpenAI | null | undefined;
let builtUtilityClient: OpenAI | null | undefined;

/** Tests inject a fake client (or null for the degraded path). */
export function setUtilityClientForTests(
  client: OpenAI | null | undefined,
): void {
  utilityOverride = client;
  builtUtilityClient = undefined;
}

/**
 * Replicates ServiceContainer's OpenAI-compatible Foundry client: Entra
 * bearer per request (DefaultAzureCredential → cognitiveservices scope)
 * with the static OPENAI_API_KEY as fallback. Construction is lazy and
 * cached; any failure yields null → callers degrade deterministically.
 */
async function getUtilityClient(): Promise<OpenAI | null> {
  if (utilityOverride !== undefined) return utilityOverride;
  if (builtUtilityClient !== undefined) return builtUtilityClient;
  try {
    const [{ env }, { default: OpenAICtor }, azureIdentity] = await Promise.all(
      [
        import('@/config/environment'),
        import('openai'),
        import('@azure/identity'),
      ],
    );
    const baseURL =
      env.AZURE_AI_FOUNDRY_OPENAI_ENDPOINT ||
      (env.AZURE_AI_FOUNDRY_ENDPOINT
        ? `${env.AZURE_AI_FOUNDRY_ENDPOINT.replace('/api/projects/default', '')}/openai/v1/`
        : undefined);
    if (!baseURL) {
      builtUtilityClient = null;
      return null;
    }
    const tokenProvider = azureIdentity.getBearerTokenProvider(
      new azureIdentity.DefaultAzureCredential(),
      'https://cognitiveservices.azure.com/.default',
    );
    const entraPreferredFetch: typeof fetch = async (input, init) => {
      try {
        const token = await tokenProvider();
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      } catch {
        return fetch(input, init);
      }
    };
    builtUtilityClient = new OpenAICtor({
      baseURL,
      apiKey: env.OPENAI_API_KEY || 'placeholder',
      fetch: entraPreferredFetch,
    });
  } catch (error) {
    console.warn(
      '[mailOrchestration] Utility client unavailable; composites degrade to deterministic behavior:',
      error instanceof Error ? error.message : error,
    );
    builtUtilityClient = null;
  }
  return builtUtilityClient;
}

export interface UtilityJsonOptions {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxCompletionTokens?: number;
}

/**
 * One batched, short-budget, strict-json utility pass. Returns null on ANY
 * failure (no client, timeout, bad JSON) — never throws, so composites
 * degrade instead of failing. Mail content passes through transiently;
 * nothing is logged or persisted.
 */
export async function runUtilityJson<T>(
  options: UtilityJsonOptions,
): Promise<T | null> {
  const client = await getUtilityClient();
  if (!client) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Utility budget exceeded')),
        UTILITY_BUDGET_MS,
      );
    });
    const response = await Promise.race([
      client.chat.completions.create({
        model: UTILITY_MODEL,
        // 'low' (not minimal), matching McpPlannerService: analysis quality
        // over a few envelopes is the whole point of the pass.
        reasoning_effort: 'low',
        max_completion_tokens:
          options.maxCompletionTokens ?? UTILITY_MAX_COMPLETION_TOKENS,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: options.schemaName,
            strict: true,
            schema: options.schema,
          },
        },
      }),
      timeout,
    ]);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as T;
  } catch (error) {
    console.warn(
      '[mailOrchestration] Utility pass failed; degrading to deterministic behavior:',
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Formats one envelope as a compact, id-carrying line for a batched
 * utility pass (ids let the model cite; previews stay short so one call
 * covers many envelopes).
 */
export function utilityEnvelopeLine(envelope: MailEnvelopeLite): string {
  return (
    `${envelope.id} | ${envelope.receivedIso.slice(0, 10)} | ` +
    `from: ${envelope.fromName || envelope.fromAddress || '?'} | ` +
    `subject: ${truncateText(envelope.subject, 80)} | ` +
    `preview: ${truncateText(envelope.preview, 120)}`
  );
}
