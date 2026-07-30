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
  from: string;
  received?: string;
  preview: string;
  hasAttachments: boolean;
  webLink?: string;
}

export type M365FeatureStatus = 'granted' | 'consent_missing' | 'error';

export type M365FeatureKey =
  | 'files'
  | 'sharepoint'
  | 'sharepointWrite'
  | 'mail';

export interface M365Status {
  features: Record<M365FeatureKey, M365FeatureStatus>;
}

export interface M365MailImportResult {
  markdown: string;
  fileName: string;
  webLink?: string;
  messageCount: number;
}

export interface M365SaveResult {
  name: string;
  webUrl?: string;
  folder: string;
}
