/**
 * Catalog of the delegated Microsoft Graph scopes requested for the M365
 * integrations (see docs/M365_GRAPH_PERMISSIONS_REQUEST.md). The scopes are
 * configured on the app registrations for every environment; whether a given
 * scope actually works depends on the tenant admin having granted consent.
 *
 * Every entry is a delegated scope: tokens are always minted from the
 * signed-in user's refresh token and only reach content that user can
 * already open in Outlook/OneDrive/Teams.
 */

export const GRAPH_SCOPE_BASE = 'https://graph.microsoft.com/';

/** Feature groupings used to request the minimum scope set per capability. */
export type M365Feature =
  | 'files'
  | 'sharepoint'
  | 'mail'
  | 'calendar'
  | 'contacts'
  | 'tasks'
  | 'teams';

export interface M365ScopeDef {
  /** Bare scope name as it appears in the request doc, e.g. 'Mail.Read'. */
  scope: string;
  /** Phase in the admin request doc (1 = core, 2 = optional, 3 = admin-only). */
  phase: 1 | 2 | 3;
  feature: M365Feature;
  /**
   * Optional read-only Graph GET (relative to /v1.0) used by the diagnostic
   * endpoint to prove the scope works end-to-end. Scopes without a probe are
   * verified by token issuance only (their probes would need extra context —
   * a team id, a shared mailbox address — or would write data).
   */
  probe?: string;
}

export const M365_SCOPES: M365ScopeDef[] = [
  // Phase 1 — core
  {
    scope: 'Files.ReadWrite.All',
    phase: 1,
    feature: 'files',
    probe: '/me/drive?$select=id,driveType',
  },
  {
    scope: 'Sites.Read.All',
    phase: 1,
    feature: 'sharepoint',
    probe: '/sites?search=*&$select=id,displayName&$top=1',
  },
  {
    scope: 'Mail.Read',
    phase: 1,
    feature: 'mail',
    probe: '/me/messages?$select=id,subject&$top=1',
  },
  {
    scope: 'Mail.ReadWrite',
    phase: 1,
    feature: 'mail',
    probe: '/me/mailFolders?$select=id,displayName&$top=1',
  },

  // Phase 2 — optional extensions
  { scope: 'Mail.Send', phase: 2, feature: 'mail' },
  {
    scope: 'Sites.ReadWrite.All',
    phase: 2,
    feature: 'sharepoint',
    probe: '/sites?search=*&$select=id,displayName&$top=1',
  },
  { scope: 'Mail.Read.Shared', phase: 2, feature: 'mail' },
  { scope: 'Mail.Send.Shared', phase: 2, feature: 'mail' },
  {
    scope: 'Chat.Read',
    phase: 2,
    feature: 'teams',
    probe: '/me/chats?$select=id&$top=1',
  },
  {
    scope: 'Calendars.ReadWrite',
    phase: 2,
    feature: 'calendar',
    probe: '/me/calendars?$select=id,name&$top=1',
  },
  { scope: 'Calendars.Read.Shared', phase: 2, feature: 'calendar' },
  {
    scope: 'Contacts.Read',
    phase: 2,
    feature: 'contacts',
    probe: '/me/contacts?$select=id&$top=1',
  },
  {
    scope: 'Tasks.ReadWrite',
    phase: 2,
    feature: 'tasks',
    probe: '/me/todo/lists?$top=1',
  },
  {
    scope: 'People.Read',
    phase: 2,
    feature: 'contacts',
    probe: '/me/people?$select=id,displayName&$top=1',
  },
  {
    scope: 'Team.ReadBasic.All',
    phase: 2,
    feature: 'teams',
    probe: '/me/joinedTeams?$select=id,displayName',
  },
  { scope: 'Channel.ReadBasic.All', phase: 2, feature: 'teams' },

  // Phase 3 — admin-consent-only
  { scope: 'OnlineMeetingTranscript.Read.All', phase: 3, feature: 'teams' },
  { scope: 'OnlineMeetingRecording.Read.All', phase: 3, feature: 'teams' },
  { scope: 'ChannelMessage.Read.All', phase: 3, feature: 'teams' },
  {
    scope: 'User.Read.All',
    phase: 3,
    feature: 'contacts',
    probe: '/users?$select=id,displayName&$top=1',
  },
  {
    scope: 'Group.Read.All',
    phase: 3,
    feature: 'teams',
    probe: '/me/memberOf?$top=1',
  },
];

/** Fully qualifies bare Graph scope names; passes through already-qualified ones. */
export function qualifyGraphScopes(scopes: string[]): string[] {
  return scopes.map((s) => (s.includes('://') ? s : `${GRAPH_SCOPE_BASE}${s}`));
}
