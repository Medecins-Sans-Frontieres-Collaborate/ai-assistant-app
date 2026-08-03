/**
 * Wire shapes shared between the /api/m365/* routes and the client. Kept
 * here (not in lib/services/m365) so client code never imports server-only
 * modules.
 */

export interface M365DriveEntry {
  driveId: string;
  itemId: string;
  name: string;
  isFolder: boolean;
  /** Folder child count, when Graph reports it. */
  childCount?: number;
  size?: number;
  mimeType?: string;
  webUrl?: string;
  lastModified?: string;
  /** Search results only: how this entry matched (name = filename hit). */
  match?: 'name' | 'content';
  /** Human-readable containing-folder path ("Projects/Kenya"), when known. */
  parentPath?: string;
  /**
   * Where the item lives — "OneDrive" or the SharePoint site slug
   * ("MSF-USA-HR") — derived from webUrl. Distinguishes same-named files
   * across sites in mixed listings (search, recent, shared).
   */
  sourceLabel?: string;
}

export type M365DriveSort = 'name' | 'lastModified' | 'size';

export type M365SortDir = 'asc' | 'desc';

export interface M365DrivePage {
  entries: M365DriveEntry[];
  /**
   * Opaque continuation token (server-encoded @odata.nextLink). Present only
   * when more results exist. Clients must treat it as a black box and echo it
   * back unchanged as `pageToken`; the server validates it against
   * graph.microsoft.com before replay.
   */
  nextToken?: string;
  /**
   * False when a requested children sort had to be dropped because Graph
   * rejected the $orderby (OneDrive for Business/SharePoint field
   * restrictions); omitted or true means the requested order was applied.
   */
  sortApplied?: boolean;
}

export interface M365SiteEntry {
  siteId: string;
  name: string;
  webUrl?: string;
}

export interface M365DriveInfo {
  driveId: string;
  name: string;
}

export interface M365MailEnvelope {
  id: string;
  conversationId?: string;
  subject: string;
  /** Combined display string ("Name <address>"), kept for back-compat with existing consumers. */
  from: string;
  /** Sender display name, when Graph provides one. */
  fromName?: string;
  /** Sender SMTP address, when Graph provides one. */
  fromAddress?: string;
  received?: string;
  preview: string;
  hasAttachments: boolean;
  /** Absent when Graph omits the property (e.g. older cached shapes). */
  isRead?: boolean;
  /** True when flag.flagStatus === 'flagged'. */
  isFlagged?: boolean;
  importance?: 'low' | 'normal' | 'high';
  /** Formatted To recipients ("Ana Diaz <ana@x>, Bo Li <bo@x>"), capped server-side at 10 + ' …'. */
  to?: string;
  /** Formatted Cc recipients, same format/cap as `to`. */
  cc?: string;
  webLink?: string;
}

export type M365MailFilter = 'unread' | 'hasAttachments' | 'flagged';

export interface M365MailPage {
  envelopes: M365MailEnvelope[];
  /**
   * Opaque continuation token for the next page (server-side it is the Graph
   * @odata.nextLink URL; the server re-validates host/path before replaying
   * it). Pass back verbatim as `pageToken`. Absent on the last page.
   */
  nextToken?: string;
}

export type M365FeatureStatus = 'granted' | 'consent_missing' | 'error';

export type M365FeatureKey =
  | 'files'
  | 'sharepoint'
  | 'sharepointWrite'
  | 'mail'
  | 'mailDrafts'
  | 'calendar'
  | 'people'
  | 'orgDirectory'
  | 'tasks'
  | 'meetings'
  | 'teamsChats'
  | 'teamsChannels'
  | 'groups';

export interface M365Status {
  features: Record<M365FeatureKey, M365FeatureStatus>;
}

export interface M365MailImportResult {
  markdown: string;
  fileName: string;
  webLink?: string;
  messageCount: number;
}

/**
 * A user-chosen save location for "Save to OneDrive". The default app folder
 * (Apps/AI Assistant) is represented as the ABSENCE of a destination (null in
 * settings), never as an instance of this type.
 */
export interface M365SaveDestination {
  driveId: string;
  /** null targets the drive root (a SharePoint document-library root). */
  itemId: string | null;
  /** Folder display name, e.g. "Reports". */
  name: string;
  /** Human-readable breadcrumb for toasts/labels, e.g. "SharePoint › Marketing › Documents › Reports". */
  pathLabel: string;
}

export interface M365SaveResult {
  name: string;
  webUrl?: string;
  /** Remote eTag after the write — doc-sync stores it as lastSyncedETag. */
  eTag?: string;
  /**
   * Present only for default app-folder saves (the "Apps/AI Assistant" path).
   * Explicit-destination saves omit it — the client already holds the label.
   */
  folder?: string;
}

export interface M365MeetingEntry {
  /** Calendar event id (not the online-meeting id — resolve via joinWebUrl). */
  eventId: string;
  subject: string;
  joinWebUrl: string;
  start?: string;
  organizer?: string;
}

export interface M365MeetingArtifact {
  id: string;
  created?: string;
}

export interface M365MeetingResources {
  meetingId: string;
  organizer?: string;
  transcripts: M365MeetingArtifact[];
  recordings: M365MeetingArtifact[];
}

export interface M365MeetingTranscript {
  transcript: string;
  speakers: string[];
  fileName: string;
}

export interface M365TeamEntry {
  /** The team's M365 group object id. */
  groupId: string;
  name: string;
}
