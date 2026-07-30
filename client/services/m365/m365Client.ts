/**
 * Client for the /api/m365/* routes. Every function throws `M365ClientError`
 * carrying the server's error `code` (e.g. M365_CONSENT_MISSING), so UI can
 * map failures to specific, actionable copy instead of a generic toast.
 */
import type {
  M365DriveEntry,
  M365DriveInfo,
  M365MailEnvelope,
  M365MailImportResult,
  M365SaveResult,
  M365SiteEntry,
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
  } catch {
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

export async function listDrive(
  view: DriveView,
  options: { driveId?: string; itemId?: string; q?: string } = {},
): Promise<M365DriveEntry[]> {
  const params = new URLSearchParams({ view });
  if (options.driveId) params.set('driveId', options.driveId);
  if (options.itemId) params.set('itemId', options.itemId);
  if (options.q) params.set('q', options.q);
  const data = await requestJson<{ entries: M365DriveEntry[] }>(
    `/api/m365/drive?${params.toString()}`,
  );
  return data.entries;
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

export async function listMail(query?: string): Promise<M365MailEnvelope[]> {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  const data = await requestJson<{ envelopes: M365MailEnvelope[] }>(
    `/api/m365/mail${suffix}`,
  );
  return data.envelopes;
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

export async function saveToOneDrive(
  blob: Blob,
  fileName: string,
): Promise<M365SaveResult> {
  const form = new FormData();
  form.append('file', blob);
  form.append('fileName', fileName);
  return requestJson<M365SaveResult>('/api/m365/save', {
    method: 'POST',
    body: form,
  });
}
