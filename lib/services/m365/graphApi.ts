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

const CONSENT_ERROR_CODE = 'AADSTS65001';

export type M365ErrorKind =
  | 'not_connected'
  | 'consent_missing'
  | 'not_found'
  | 'forbidden'
  | 'graph_error';

export class M365Error extends Error {
  constructor(
    message: string,
    readonly kind: M365ErrorKind,
    readonly status: number,
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

/** Mints a delegated Graph token or throws a typed M365Error. */
export async function mintGraphToken(
  req: NextRequest,
  scopes: string[],
): Promise<string> {
  const result = await getGraphAccessToken(req, scopes);
  if (result.accessToken) {
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
  throw new M365Error(
    result.error || 'Failed to acquire a Microsoft Graph token',
    'graph_error',
    502,
  );
}

/**
 * Fetches a Graph endpoint with a freshly minted delegated token.
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
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body?.error?.message || `Graph request failed (${response.status})`;
    if (response.status === 404) {
      throw new M365Error(message, 'not_found', 404);
    }
    if (response.status === 403 || response.status === 401) {
      throw new M365Error(message, 'forbidden', 403);
    }
    throw new M365Error(message, 'graph_error', 502);
  }
  return response;
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
  graph_error: 'M365_GRAPH_ERROR',
};

/** Maps M365Error to the standard error envelope; falls back to handleApiError. */
export function m365ErrorResponse(error: unknown): NextResponse {
  if (error instanceof M365Error) {
    return errorResponse(
      error.message,
      error.status,
      undefined,
      ERROR_CODES[error.kind],
    );
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
    if (host.endsWith('-my.sharepoint.com') || segments[0] === 'personal') {
      return 'OneDrive';
    }
    if (host.endsWith('.sharepoint.com')) {
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
