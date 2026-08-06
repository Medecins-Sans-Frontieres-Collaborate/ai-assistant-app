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
  M365MeetingEntry,
  M365MeetingResources,
  M365MeetingTranscript,
  M365SaveResult,
  M365SiteEntry,
  M365SortDir,
  M365Status,
  M365TeamEntry,
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
  /** Search view only: extension filter for the guaranteed name matches. */
  types?: readonly string[];
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
  if (options.types?.length) params.set('types', options.types.join(','));
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

export async function searchSites(
  query: string,
  signal?: AbortSignal,
): Promise<M365SiteEntry[]> {
  const data = await requestJson<{ sites: M365SiteEntry[] }>(
    `/api/m365/sites?q=${encodeURIComponent(query)}`,
    signal ? { signal } : undefined,
  );
  return data.sites;
}

export interface M365GroupEntry {
  /** Entra group object id — the value access rules and overrides persist. */
  id: string;
  name: string;
}

/** Typeahead search for the admin group pickers (Group.Read.All delegated). */
export async function searchEntraGroups(
  query: string,
): Promise<M365GroupEntry[]> {
  const data = await requestJson<{ groups: M365GroupEntry[] }>(
    `/api/m365/groups?q=${encodeURIComponent(query)}`,
  );
  return data.groups;
}

/** Fresh display names for stored group ids — resolved on editor open. */
export async function lookupEntraGroups(
  ids: string[],
): Promise<M365GroupEntry[]> {
  if (ids.length === 0) return [];
  const data = await requestJson<{ groups: M365GroupEntry[] }>(
    `/api/m365/groups?ids=${encodeURIComponent(ids.join(','))}`,
  );
  return data.groups;
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

export async function listMeetings(): Promise<M365MeetingEntry[]> {
  const data = await requestJson<{ meetings: M365MeetingEntry[] }>(
    '/api/m365/meetings',
  );
  return data.meetings;
}

export async function resolveMeeting(
  joinWebUrl: string,
): Promise<M365MeetingResources> {
  return requestJson<M365MeetingResources>(
    `/api/m365/meetings?joinWebUrl=${encodeURIComponent(joinWebUrl)}`,
  );
}

export async function fetchMeetingTranscript(
  meetingId: string,
  transcriptId: string,
  context: { subject?: string; start?: string } = {},
): Promise<M365MeetingTranscript> {
  const params = new URLSearchParams({ meetingId, transcriptId });
  if (context.subject) params.set('subject', context.subject);
  if (context.start) params.set('start', context.start);
  return requestJson<M365MeetingTranscript>(
    `/api/m365/meetings?${params.toString()}`,
  );
}

/** Tier 2: server-side recording import into upload storage (§3 pipeline). */
export async function importMeetingRecording(
  meetingId: string,
  recordingId: string,
  fileName: string,
): Promise<M365ImportedUploadRef> {
  return requestJson<M365ImportedUploadRef>('/api/m365/meetings/recording', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingId, recordingId, fileName }),
  });
}

/** Creates a user-confirmed batch of tasks in the "AI Assistant" To Do list. */
export async function createTodoTasks(
  tasks: string[],
): Promise<{ created: number; listName: string }> {
  return requestJson<{ created: number; listName: string }>('/api/m365/todo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
}

export async function listJoinedTeams(): Promise<M365TeamEntry[]> {
  const data = await requestJson<{ teams: M365TeamEntry[] }>('/api/m365/teams');
  return data.teams;
}

/** A team's default document library (its M365 group drive). */
export async function getTeamDrive(
  groupId: string,
): Promise<{ driveId: string; name: string }> {
  const data = await requestJson<{ drive: { driveId: string; name: string } }>(
    `/api/m365/teams?groupId=${encodeURIComponent(groupId)}`,
  );
  return data.drive;
}

export interface M365DriveItemMeta {
  name: string;
  eTag?: string;
  webUrl?: string;
  lastModified?: string;
  size?: number;
}

/** Lightweight metadata read — the doc-sync pull poll ($select=eTag&co). */
export async function getDriveItemMeta(
  driveId: string,
  itemId: string,
  options: { signal?: AbortSignal } = {},
): Promise<M365DriveItemMeta> {
  const params = new URLSearchParams({ driveId, itemId });
  return requestJson<M365DriveItemMeta>(
    `/api/m365/drive/item?${params.toString()}`,
    { signal: options.signal },
  );
}

export interface M365UpdateContentResult {
  name: string;
  eTag?: string;
  webUrl?: string;
}

/**
 * Overwrites an EXISTING drive item's content, guarded by If-Match — a
 * remote edit since `ifMatch` surfaces as M365ClientError code
 * M365_CONFLICT, never a blind overwrite. Doc-sync push path.
 */
export async function updateDriveItemContent(
  blob: Blob,
  fileName: string,
  target: { driveId: string; itemId: string; ifMatch?: string },
): Promise<M365UpdateContentResult> {
  const form = new FormData();
  form.append('file', blob);
  form.append('fileName', fileName);
  form.append('driveId', target.driveId);
  form.append('itemId', target.itemId);
  if (target.ifMatch) form.append('ifMatch', target.ifMatch);
  return requestJson<M365UpdateContentResult>('/api/m365/save', {
    method: 'POST',
    body: form,
  });
}

export interface M365ImportedUploadRef {
  /** `/api/file/{blobFilename}` — same reference shape as a local upload. */
  uri: string;
  name: string;
  size: number;
  mimeType: string;
  category: 'image' | 'audio' | 'video' | 'document' | 'unknown';
  eTag?: string;
  webUrl?: string;
}

/**
 * Imports a drive item server-side straight into upload storage — bytes
 * never pass through the browser. Use for large media (transcription) and
 * anywhere the file is consumed server-side anyway.
 */
export async function importDriveItemToStorage(
  driveId: string,
  itemId: string,
): Promise<M365ImportedUploadRef> {
  return requestJson<M365ImportedUploadRef>('/api/m365/import/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driveId, itemId }),
  });
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

export interface M365ShareResult {
  /** Present for organization-link shares. */
  link?: string;
  scope: 'organization' | 'people';
  granted?: number;
}

/**
 * Creates view-only sharing on an item the user owns (see
 * /api/m365/share): an organization link when `emails` is absent, else
 * read grants for those specific people.
 */
export async function shareDriveItem(
  driveId: string,
  itemId: string,
  emails?: string[],
): Promise<M365ShareResult> {
  return requestJson<M365ShareResult>('/api/m365/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      driveId,
      itemId,
      ...(emails?.length && { emails }),
    }),
  });
}

export interface M365PersonSuggestion {
  displayName: string;
  email: string;
}

/**
 * People autocomplete for recipient fields — relevance-ranked contacts
 * plus a directory supplement, resolved server-side with the user's own
 * Graph token. Callers should treat failures as "no suggestions".
 */
export async function searchPeople(
  query: string,
  signal?: AbortSignal,
): Promise<M365PersonSuggestion[]> {
  const result = await requestJson<{ people: M365PersonSuggestion[] }>(
    `/api/m365/people/search?q=${encodeURIComponent(query)}`,
    { signal },
  );
  return result.people;
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
