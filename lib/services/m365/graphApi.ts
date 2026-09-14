/**
 * Server-side Microsoft Graph access for the M365 integrations.
 *
 * Every call is delegated: a token is minted per request from the signed-in
 * user's refresh token with exactly the scopes the operation needs (see
 * docs/M365_FIRST_PASS_DESIGN.md). Tokens are never persisted and never reach
 * the client. A tenant-consent gap surfaces as `consent_missing` so routes
 * can tell "feature not enabled by the tenant" apart from a real fault.
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  GraphMailRecipient,
  formatMailRecipient,
} from '@/lib/services/m365/mailMarkdown';

import {
  errorResponse,
  handleApiError,
} from '@/lib/utils/server/api/apiResponse';

import type { M365DriveEntry, M365MailEnvelope } from '@/types/m365';

import { getGraphAccessToken } from '@/auth';

export const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';

export const CONSENT_ERROR_CODE = 'AADSTS65001';

/**
 * AAD refresh-token failures that mean "sign in again", not "Graph is
 * broken": expired/revoked refresh tokens (70008, 700082, 700084, 50173),
 * conditional-access / MFA interaction required (50076, 50078, 50079,
 * 53003), session expiry by policy (70043, 70044), silent-auth failure
 * (50058). Anything else stays `graph_error` so a real outage is not
 * misreported as a disconnected account.
 */
const RECONNECT_ERROR_CODES =
  /AADSTS(70008|70043|70044|50058|50076|50078|50079|50173|53003|500133|700082|700084)\b/;

export type M365ErrorKind =
  | 'not_connected'
  | 'consent_missing'
  | 'not_found'
  | 'forbidden'
  | 'rate_limited'
  | 'graph_error';

export class M365Error extends Error {
  constructor(
    message: string,
    readonly kind: M365ErrorKind,
    readonly status: number,
    /** Graph throttle hint, seconds — only set for `rate_limited`. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'M365Error';
  }
}

/**
 * Conservative charset for Graph resource ids (drive items, messages,
 * drives, sites). Ids are embedded into Graph URL paths, so anything
 * outside this set is rejected before it can alter the request shape.
 */
export const GRAPH_ID_REGEX = /^[A-Za-z0-9!$_.,=-]{1,512}$/;

export function isValidGraphId(id: string | null | undefined): id is string {
  return typeof id === 'string' && GRAPH_ID_REGEX.test(id);
}

/**
 * Opt-in per-request token cache. A Graph access token lives ~60–90
 * minutes, but an index step or a 50-item probe used to redeem the
 * refresh token once PER CALL — hundreds of AAD round-trips per job, and
 * AAD throttles the token endpoint long before Graph throttles the data
 * calls. A fan-out path wraps itself in {@link withGraphTokenCache}; the
 * cache is keyed weakly by the request object (nothing outlives the
 * request) and by the sorted scope set (different scopes are different
 * tokens). Single-call routes stay uncached — one mint per request is
 * what they did before, and it keeps token state out of every test that
 * varies the mint result on a shared request object.
 */
const TOKEN_CACHE_TTL_MS = 50 * 60_000;
type TokenBucket = Map<string, { token: string; at: number }>;
const tokenCache = new WeakMap<object, TokenBucket>();

function scopeKey(scopes: string[]): string {
  return [...scopes].sort().join(' ');
}

/**
 * Runs `fn` with token caching enabled for `req`. Nested wraps share the
 * outer bucket; the outermost wrap drops it when done.
 */
export async function withGraphTokenCache<T>(
  req: NextRequest,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = tokenCache.get(req);
  if (outer) return fn();
  tokenCache.set(req, new Map());
  try {
    return await fn();
  } finally {
    tokenCache.delete(req);
  }
}

/** Drops a cached token after Graph rejects it (401) — the next call re-mints. */
export function evictGraphToken(req: NextRequest, scopes: string[]): void {
  tokenCache.get(req)?.delete(scopeKey(scopes));
}

/** Mints a delegated Graph token or throws a typed M365Error. */
export async function mintGraphToken(
  req: NextRequest,
  scopes: string[],
): Promise<string> {
  const key = scopeKey(scopes);
  const bucket = tokenCache.get(req);
  const cached = bucket?.get(key);
  if (cached && Date.now() - cached.at < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  const result = await getGraphAccessToken(req, scopes);
  if (result.accessToken) {
    bucket?.set(key, { token: result.accessToken, at: Date.now() });
    return result.accessToken;
  }
  if (result.error?.includes(CONSENT_ERROR_CODE)) {
    throw new M365Error(
      `Tenant consent has not been granted for: ${scopes.join(', ')}`,
      'consent_missing',
      403,
    );
  }
  if (result.error === 'No refresh token available') {
    throw new M365Error(
      'No Microsoft 365 session is available for this user',
      'not_connected',
      401,
    );
  }
  if (
    result.error &&
    (RECONNECT_ERROR_CODES.test(result.error) ||
      /\binvalid_grant\b|\binteraction_required\b/i.test(result.error))
  ) {
    throw new M365Error(
      'Your Microsoft 365 session has expired — sign out and back in to reconnect',
      'not_connected',
      401,
    );
  }
  throw new M365Error(
    result.error || 'Failed to acquire a Microsoft Graph token',
    'graph_error',
    502,
  );
}

/** Retry policy for throttled / briefly unavailable Graph responses. */
const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_RETRY_WAIT_MS = 2_000;

function retryDelayMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after'));
  const hinted =
    Number.isFinite(header) && header > 0
      ? header * 1000
      : DEFAULT_RETRY_WAIT_MS * attempt;
  return Math.min(hinted, MAX_RETRY_WAIT_MS);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` that retries 429/503 up to MAX_ATTEMPTS, honouring Retry-After
 * (capped at MAX_RETRY_WAIT_MS so a hostile hint cannot pin a request).
 * Used for Graph calls and for the pre-authenticated download URLs Graph
 * hands out, which throttle the same way. Non-retryable statuses and
 * network errors surface unchanged.
 */
export async function fetchWithGraphRetry(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let response = await fetch(url, init);
  for (
    let attempt = 1;
    attempt < MAX_ATTEMPTS && RETRY_STATUSES.has(response.status);
    attempt++
  ) {
    const delay = retryDelayMs(response, attempt);
    // Drain so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    await sleep(delay);
    response = await fetch(url, init);
  }
  return response;
}

/**
 * Fetches a Graph endpoint with a delegated token (minted once per request
 * and scope set, see the token cache above). 429/503 are retried with
 * Retry-After before the error mapping runs.
 * `path` is relative to /v1.0 unless it is already absolute (e.g. an
 * @odata.nextLink or a pre-authenticated download URL).
 */
export async function graphFetch(
  req: NextRequest,
  scopes: string[],
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await mintGraphToken(req, scopes);
  const url = path.startsWith('https://') ? path : `${GRAPH_V1}${path}`;
  const response = await fetchWithGraphRetry(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    // A rejected token must not be served again from the cache.
    if (response.status === 401) evictGraphToken(req, scopes);
    throw await graphErrorFromResponse(response);
  }
  return response;
}

/**
 * Maps a non-OK Graph response to a typed M365Error — the single mapping
 * every M365 caller shares (graphFetch, the save route's overwrite fetch,
 * the backup drive store). 429 keeps its status and Retry-After so clients
 * get a real backoff signal instead of a generic 502; 401 means the token
 * itself was rejected (not a permission gap), which is a reconnect problem.
 */
export async function graphErrorFromResponse(
  response: Response,
  fallback = 'Graph request failed',
): Promise<M365Error> {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message || `${fallback} (${response.status})`;
  if (response.status === 404) {
    return new M365Error(message, 'not_found', 404);
  }
  if (response.status === 401) {
    return new M365Error(message, 'not_connected', 401);
  }
  if (response.status === 403) {
    return new M365Error(message, 'forbidden', 403);
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return new M365Error(
      'Microsoft Graph throttled the request',
      'rate_limited',
      429,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5,
    );
  }
  return new M365Error(message, 'graph_error', 502);
}

export async function graphJson<T = unknown>(
  req: NextRequest,
  scopes: string[],
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await graphFetch(req, scopes, path, init);
  return (await response.json()) as T;
}

const ERROR_CODES: Record<M365ErrorKind, string> = {
  not_connected: 'M365_NOT_CONNECTED',
  consent_missing: 'M365_CONSENT_MISSING',
  not_found: 'M365_NOT_FOUND',
  forbidden: 'M365_FORBIDDEN',
  rate_limited: 'M365_RATE_LIMITED',
  graph_error: 'M365_GRAPH_ERROR',
};

/** Maps M365Error to the standard error envelope; falls back to handleApiError. */
export function m365ErrorResponse(error: unknown): NextResponse {
  if (error instanceof M365Error) {
    const response = errorResponse(
      error.message,
      error.status,
      undefined,
      ERROR_CODES[error.kind],
    );
    if (error.kind === 'rate_limited' && error.retryAfterSeconds) {
      response.headers.set('Retry-After', String(error.retryAfterSeconds));
    }
    return response;
  }
  return handleApiError(error, 'Microsoft 365 request failed');
}

// ---------------------------------------------------------------------------
// Normalization to the shared wire shapes (types/m365.ts)
// ---------------------------------------------------------------------------

export type {
  M365DriveEntry,
  M365DriveInfo,
  M365MailEnvelope,
  M365SiteEntry,
} from '@/types/m365';

// Loose Graph shapes — only the fields we read.
interface GraphDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  parentReference?: { driveId?: string; path?: string };
  remoteItem?: GraphDriveItem;
}

interface GraphMessageShape {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: GraphMailRecipient;
  receivedDateTime?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
  webLink?: string;
}

/**
 * Normalizes a Graph driveItem to the wire shape. Items from
 * `sharedWithMe` carry the real location under `remoteItem`; the outer item
 * has no usable drive id, so the remote wins wherever present.
 */
/**
 * SharePoint Online hosts are always a single tenant label:
 * `tenant.sharepoint.com`, personal sites `tenant-my.sharepoint.com`.
 * Anchored rather than `endsWith` so a lookalike host
 * (`sharepoint.com.evil.example`) can never borrow the label — these feed a
 * DISPLAY string only, but a source label that lies about provenance is
 * exactly the kind of thing a phishing link wants.
 */
const PERSONAL_SHAREPOINT_HOST = /^[a-z0-9-]+-my\.sharepoint\.com$/;
const SHAREPOINT_HOST = /^[a-z0-9-]+\.sharepoint\.com$/;

/**
 * "https://msfusa.sharepoint.com/sites/HR/Shared Documents/x.docx" → "HR";
 * personal OneDrive hosts → "OneDrive"; other hosts → hostname. Pure URL
 * slug parsing — site DISPLAY names would need per-site Graph lookups.
 */
function driveSourceLabel(webUrl: string | undefined): string | undefined {
  if (!webUrl) return undefined;
  try {
    const url = new URL(webUrl);
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    if (PERSONAL_SHAREPOINT_HOST.test(host) || segments[0] === 'personal') {
      return 'OneDrive';
    }
    if (SHAREPOINT_HOST.test(host)) {
      if ((segments[0] === 'sites' || segments[0] === 'teams') && segments[1]) {
        return decodeURIComponent(segments[1]);
      }
      return host.replace(/\.sharepoint\.com$/, '');
    }
    return host;
  } catch {
    return undefined;
  }
}

/** "/drives/x/root:/Projects/Kenya" | "/drive/root:/Projects" → "Projects/Kenya". */
function prettyParentPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const idx = path.indexOf('root:');
  const tail = idx >= 0 ? path.slice(idx + 5) : path;
  const cleaned = decodeURIComponent(tail).replace(/^\//, '');
  return cleaned || undefined;
}

export function normalizeDriveItem(
  item: GraphDriveItem | null | undefined,
): M365DriveEntry | null {
  if (!item) return null;
  const target = item.remoteItem ?? item;
  const driveId = target.parentReference?.driveId;
  const itemId = target.id;
  const name = target.name ?? item.name;
  if (!driveId || !itemId || !name) return null;
  return {
    driveId,
    itemId,
    name,
    isFolder: !!target.folder,
    ...(target.folder?.childCount !== undefined && {
      childCount: target.folder.childCount,
    }),
    ...(target.size !== undefined && { size: target.size }),
    ...(target.file?.mimeType && { mimeType: target.file.mimeType }),
    ...((target.webUrl ?? item.webUrl) && {
      webUrl: target.webUrl ?? item.webUrl,
    }),
    ...(target.lastModifiedDateTime && {
      lastModified: target.lastModifiedDateTime,
    }),
    ...(prettyParentPath(target.parentReference?.path) && {
      parentPath: prettyParentPath(target.parentReference?.path),
    }),
    ...(driveSourceLabel(target.webUrl ?? item.webUrl) && {
      sourceLabel: driveSourceLabel(target.webUrl ?? item.webUrl),
    }),
  };
}

export function normalizeMailEnvelope(
  message: GraphMessageShape | null | undefined,
): M365MailEnvelope | null {
  if (!message?.id) return null;
  return {
    id: message.id,
    ...(message.conversationId && { conversationId: message.conversationId }),
    subject: message.subject?.trim() || '(no subject)',
    from: formatMailRecipient(message.from),
    ...(message.receivedDateTime && { received: message.receivedDateTime }),
    preview: message.bodyPreview?.trim() ?? '',
    hasAttachments: !!message.hasAttachments,
    ...(message.webLink && { webLink: message.webLink }),
  };
}
