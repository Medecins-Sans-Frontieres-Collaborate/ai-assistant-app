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

export type M365PickerTab =
  | 'onedrive'
  | 'recent'
  | 'shared'
  | 'sharepoint'
  | 'teams';

/**
 * One drill-down step in the attach picker: a folder (OneDrive), or a
 * site/library (SharePoint), or a team (Teams).
 */
export interface M365PickerCrumb {
  label: string;
  siteId?: string;
  driveId?: string;
  itemId?: string;
  /**
   * The real path between the previous crumb and this one is unknown (the
   * folder was opened from search results, which span the whole drive);
   * rendered with a leading "…" segment instead of fabricating a path.
   */
  elided?: boolean;
}

/**
 * Last browsed location in the attach picker, remembered across openings.
 * null = start at the OneDrive root. Written on navigation only — searching
 * never moves it — and dropped fail-open when the folder no longer loads.
 */
export interface M365PickerLocation {
  tab: M365PickerTab;
  crumbs: M365PickerCrumb[];
  sort: M365DriveSort;
  dir: M365SortDir;
}

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

/**
 * Browse listing for the SharePoint tab (GET /api/m365/sites without q).
 * `followed` is the user's favorited sites (/me/followedSites, best-effort —
 * may be empty) and is present on the FIRST page only; `sites` is the
 * permission-trimmed all-sites listing, deduped against `followed` on the
 * first page. `nextToken` pages `sites` via the `pageToken` param.
 */
export interface M365SitesPage {
  followed?: M365SiteEntry[];
  sites: M365SiteEntry[];
  nextToken?: string;
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
  /**
   * Picker tab the destination was chosen from, recorded so the folder
   * picker can reopen at the destination instead of the root. Optional:
   * destinations persisted before this field existed open at the root.
   */
  tab?: M365PickerTab;
  /**
   * Breadcrumb trail to the destination folder (last crumb is the folder
   * itself), for reopening the picker in place. Same optionality as `tab`.
   */
  crumbs?: M365PickerCrumb[];
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
  /** Graph item reference for follow-up calls (doc-sync binding, sharing). */
  itemId?: string;
  driveId?: string;
}

export interface M365MeetingEntry {
  /** Calendar event id (not the online-meeting id — resolve via joinWebUrl). */
  eventId: string;
  subject: string;
  joinWebUrl: string;
  start?: string;
  /**
   * Event end, mirroring `start`. The filtered listing needs it (a meeting
   * that has not ended cannot have a transcript yet); the plain listing
   * just carries it.
   */
  end?: string;
  organizer?: string;
  /**
   * Filtered listing only: how many calendarView occurrences collapsed into
   * this row when deduping by joinWebUrl. A recurring Teams series expands
   * to one event per occurrence, all sharing one join URL and one
   * online-meeting id (and therefore one set of transcripts). Absent for a
   * single-instance meeting.
   */
  occurrences?: number;
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

/**
 * Outcome of the server-side artifact probe for one meeting.
 *
 * - 'available' — the probe found at least one transcript or recording;
 *   `resources` is inline so the client needs no expand-time resolve.
 * - 'pending' — the probe found nothing, but the meeting ended so recently
 *   that Teams may still be publishing. Kept rather than hidden.
 * - 'forbidden' — Graph answered 403. That is NOT "no artifacts";
 *   availability is unknown, so the row is kept and badged.
 * - 'unprobed' — never asked (cap, wall-clock budget, throttling, or the
 *   client-side unfiltered listing, which probes nothing at all).
 *
 * A meeting that probed clean with zero artifacts is not represented here:
 * it is dropped from `meetings` and counted in `hiddenCount`. That is the
 * only outcome that hides a row.
 */
export type M365MeetingAvailability =
  | 'available'
  | 'pending'
  | 'forbidden'
  | 'unprobed';

export interface M365MeetingCandidate extends M365MeetingEntry {
  availability: M365MeetingAvailability;
  /** Set only for 'available' — the same shape the lazy resolve returns. */
  resources?: M365MeetingResources;
  /**
   * One of the two artifact listings failed transiently while the other
   * succeeded: `resources` is real but may under-report.
   */
  partial?: boolean;
}

/** Payload of GET /api/m365/meetings?artifacts=required. */
export interface M365FilteredMeetingList {
  /** Newest first. Only 'available' | 'pending' | 'forbidden' rows. */
  meetings: M365MeetingCandidate[];
  /**
   * Every meeting this view dropped, for any reason: probed clean and
   * empty, cancelled, still running, or unknown. It is what the "Show all
   * meetings (N hidden)" toggle promises to reveal, so it deliberately
   * counts more than the provably-empty ones.
   */
  hiddenCount: number;
  /**
   * The subset of `hiddenCount` whose availability is unknown rather than
   * disproven — the probe cap or wall-clock budget was reached, or Graph
   * throttled. Reaching these is what "Show all" is for.
   */
  unprobedCount: number;
  /** The probe cap or wall-clock budget cut the fan-out short. */
  budgetExhausted?: boolean;
  /** Graph throttled during the probe phase; the listing still returns 200. */
  throttled?: boolean;
  /**
   * The raw calendar window filled its page before any filtering, so older
   * meetings in the lookback were never considered.
   */
  windowTruncated?: boolean;
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
