/**
 * Wire shapes of the analytics API. Types only — safe for client code.
 */
import { FolderAccess } from '@/lib/services/analytics/access';
import { AnalyticsFieldId } from '@/lib/services/analytics/fields';
import { TableSummary, TableView } from '@/lib/services/analytics/previewModel';
import { DeliveryCadence } from '@/lib/services/analytics/reportTypes';
import { ReportPeriod } from '@/lib/services/analytics/retention';
import { RollupView } from '@/lib/services/analytics/rollupModel';
import {
  AnalyticsFieldPolicyDocument,
  AnalyticsFileStatus,
  AnalyticsFoldersDocument,
  AnalyticsIssue,
  AnalyticsReportTypeId,
} from '@/lib/services/analytics/types';
import { FolderView, OriginalBlock } from '@/lib/services/analytics/viewModel';

export interface AnalyticsAccessResponse {
  hasAccess: boolean;
  canAdmin: boolean;
}

export interface AnalyticsTreeResponse {
  folders: FolderView[];
  canAdmin: boolean;
  /** Group membership could not be read; group-granted folders are missing. */
  groupsDegraded: boolean;
  /** The delivery container could not be listed. */
  deliveryUnavailable: boolean;
}

export type DownloadBlock = 'view-only' | OriginalBlock;

export interface AnalyticsFileDto {
  id: string;
  name: string;
  size: number;
  period: ReportPeriod | null;
  deliveredAt: string;
  expiresAt: string;
  canDownload: boolean;
  /** Why the delivered file cannot be downloaded; null when it can. */
  downloadBlock: DownloadBlock | null;
  /** Can be opened in the app. */
  canPreview: boolean;
  /** Can be exported as CSV / a workbook with hidden fields removed. */
  canExport: boolean;
  /** Has a dashboard this person may open. */
  canViewDashboard: boolean;
  /** Admins only. */
  admin?: {
    validation: 'pending' | AnalyticsFileStatus;
    expired: boolean;
    issues: AnalyticsIssue[];
    /** What stops a non-admin from downloading it, if anything. */
    originalBlock: OriginalBlock | null;
  };
}

export interface AnalyticsFilesResponse {
  folder: string;
  access: FolderAccess;
  files: AnalyticsFileDto[];
}

export interface AnalyticsFoldersAdminResponse {
  document: AnalyticsFoldersDocument | null;
  etag: string | null;
  unavailable: boolean;
  /** Raw folders and the platform field policy are theirs alone. */
  isGlobalAdmin: boolean;
  /** Every folder path that exists in storage or in the overlay. */
  paths: string[];
}

export interface AnalyticsFieldPolicyAdminResponse {
  document: AnalyticsFieldPolicyDocument | null;
  etag: string | null;
  unavailable: boolean;
  canEdit: boolean;
}

export interface AnalyticsProblemDto {
  id: string;
  path: string;
  validation: 'pending' | AnalyticsFileStatus;
  issues: AnalyticsIssue[];
  firstSeenAt: string | null;
}

export interface AnalyticsHealthResponse {
  deliveryUnavailable: boolean;
  foldersUnavailable: boolean;
  policyUnavailable: boolean;
  /** Storage container the app is reading, for the "not reachable" message. */
  container: string;
  /**
   * 'active' — expired files are deleted after the grace period;
   * 'disabled' — switched off by configuration;
   * 'waiting-for-config' — nothing is deleted until a folder overlay is saved.
   */
  retentionDeletion: 'active' | 'disabled' | 'waiting-for-config';
  graceDays: number;
  totals: {
    files: number;
    ok: number;
    warning: number;
    error: number;
    pending: number;
  };
  problems: AnalyticsProblemDto[];
  unconfiguredFolders: string[];
  staleFolders: {
    path: string;
    cadence: DeliveryCadence;
    lastPeriodEnd: string | null;
  }[];
  unclassifiedColumns: { column: string; files: number }[];
  expiring: { id: string; path: string; expiresAt: string; expired: boolean }[];
}

export interface AnalyticsPreviewResponse {
  file: { id: string; name: string };
  access: FolderAccess;
  tables: TableSummary[];
  canExport: boolean;
  /** Rows kept per table in the preview. */
  previewRows: number;
}

export type AnalyticsTableResponse = TableView;

export interface AnalyticsDashboardResponse extends RollupView {
  file: { id: string; name: string };
  period: ReportPeriod | null;
  access: FolderAccess;
}

export interface AnalyticsTrendPoint extends RollupView {
  file: { id: string; name: string };
  period: ReportPeriod;
}

export interface AnalyticsTrendResponse {
  /** Null when the folder has no single run of reports to plot. */
  reportType: AnalyticsReportTypeId | null;
  /**
   * 'ok' — points are in period order;
   * 'none' — fewer than two reports with a period;
   * 'mixed-types' — reports of more than one type under this folder;
   * 'several-per-period' — several reports cover the same period (one per
   *   section, say): open a sub-folder to see one run.
   */
  status: 'ok' | 'none' | 'mixed-types' | 'several-per-period';
  points: AnalyticsTrendPoint[];
}

export type { AnalyticsFieldId };
