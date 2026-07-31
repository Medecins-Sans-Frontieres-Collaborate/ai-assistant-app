/**
 * Client for the /api/m365/* routes. Every function throws `M365ClientError`
 * carrying the server's error `code` (e.g. M365_CONSENT_MISSING), so UI can
 * map failures to specific, actionable copy instead of a generic toast.
 */
import type {
  M365DriveEntry,
  M365DriveInfo,
  M365DrivePage,
  M365DriveSort,
  M365MailFilter,
  M365MailImportResult,
  M365MailPage,
  M365SaveResult,
  M365SiteEntry,
  M365SortDir,
  M365Status,
} from '@/types/m365';

export class M365ClientError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'M365ClientError';
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error; // caller cancelled — never a user-facing error
    }
    throw new M365ClientError('Network error', 'NETWORK');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new M365ClientError(
      body?.error || `Request failed (${response.status})`,
      body?.code,
    );
  }
  return body.data as T;
}

export async function fetchM365Status(): Promise<M365Status> {
  return requestJson<M365Status>('/api/m365/status');
}

export type DriveView = 'children' | 'recent' | 'shared' | 'search';

/** Search-as-you-type tuning shared by the M365 picker and mail modals. */
export const M365_SEARCH_DEBOUNCE_MS = 300;
export const M365_SEARCH_MIN_CHARS = 2;

export interface ListDriveOptions {
  driveId?: string;
  itemId?: string;
  q?: string;
  sort?: M365DriveSort; // children view only; ignored by other views
  dir?: M365SortDir;
  pageToken?: string; // opaque M365DrivePage.nextToken echo
  signal?: AbortSignal; // cancels the underlying fetch
}

export async function listDrivePage(
  view: DriveView,
  options: ListDriveOptions = {},
): Promise<M365DrivePage> {
  const params = new URLSearchParams({ view });
  if (options.driveId) params.set('driveId', options.driveId);
  if (options.itemId) params.set('itemId', options.itemId);
  if (options.q) params.set('q', options.q);
  if (options.sort) params.set('sort', options.sort);
  if (options.dir) params.set('dir', options.dir);
  if (options.pageToken) params.set('pageToken', options.pageToken);
  return requestJson<M365DrivePage>(
    `/api/m365/drive?${params.toString()}`,
    options.signal ? { signal: options.signal } : undefined,
  );
}

export async function listDrive(
  view: DriveView,
  options: ListDriveOptions = {},
): Promise<M365DriveEntry[]> {
  return (await listDrivePage(view, options)).entries;
}

export async function searchSites(query: string): Promise<M365SiteEntry[]> {
  const data = await requestJson<{ sites: M365SiteEntry[] }>(
    `/api/m365/sites?q=${encodeURIComponent(query)}`,
  );
  return data.sites;
}

export async function listSiteDrives(siteId: string): Promise<M365DriveInfo[]> {
  const data = await requestJson<{ drives: M365DriveInfo[] }>(
    `/api/m365/sites?siteId=${encodeURIComponent(siteId)}`,
  );
  return data.drives;
}

export interface DownloadedDriveItem {
  blob: Blob;
  name: string;
  webUrl?: string;
}

export async function downloadDriveItem(
  driveId: string,
  itemId: string,
): Promise<DownloadedDriveItem> {
  const params = new URLSearchParams({ driveId, itemId });
  let response: Response;
  try {
    response = await fetch(`/api/m365/import?${params.toString()}`);
  } catch {
    throw new M365ClientError('Network error', 'NETWORK');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new M365ClientError(
      body?.error || `Import failed (${response.status})`,
      body?.code,
    );
  }
  const blob = await response.blob();
  const rawName = response.headers.get('X-M365-Name');
  const rawWebUrl = response.headers.get('X-M365-Web-Url');
  return {
    blob,
    name: rawName ? decodeURIComponent(rawName) : 'file',
    ...(rawWebUrl && { webUrl: decodeURIComponent(rawWebUrl) }),
  };
}

export interface ListMailOptions {
  /** Free-text mailbox search; when set, results are relevance-ordered by Graph. */
  q?: string;
  /** Server-side filters (AND-combined). The server ignores these when `q` is set — Graph cannot combine $search with $filter — so callers must filter search results client-side. */
  filters?: M365MailFilter[];
  /** Opaque continuation token from a previous M365MailPage.nextToken; when set, q/filters are ignored (the token encodes the original query). */
  pageToken?: string;
  /** Cancels the underlying fetch. */
  signal?: AbortSignal;
}

export async function listMail(
  options: ListMailOptions = {},
): Promise<M365MailPage> {
  const params = new URLSearchParams();
  if (options.pageToken) {
    params.set('pageToken', options.pageToken);
  } else {
    if (options.q) params.set('q', options.q);
    if (options.filters?.length)
      params.set('filters', options.filters.join(','));
  }
  const qs = params.toString();
  return requestJson<M365MailPage>(
    `/api/m365/mail${qs ? `?${qs}` : ''}`,
    options.signal ? { signal: options.signal } : undefined,
  );
}

export async function fetchMailImport(
  ref: { messageId: string } | { conversationId: string },
): Promise<M365MailImportResult> {
  const params = new URLSearchParams(
    'messageId' in ref
      ? { messageId: ref.messageId }
      : { conversationId: ref.conversationId },
  );
  return requestJson<M365MailImportResult>(
    `/api/m365/mail?${params.toString()}`,
  );
}

export interface M365SaveTarget {
  driveId: string;
  /** Omit to target the drive root (SharePoint library root). */
  parentId?: string;
}

export async function saveToOneDrive(
  blob: Blob,
  fileName: string,
  target?: M365SaveTarget,
): Promise<M365SaveResult> {
  const form = new FormData();
  form.append('file', blob);
  form.append('fileName', fileName);
  if (target) {
    form.append('driveId', target.driveId);
    if (target.parentId) form.append('parentId', target.parentId);
  }
  return requestJson<M365SaveResult>('/api/m365/save', {
    method: 'POST',
    body: form,
  });
}
