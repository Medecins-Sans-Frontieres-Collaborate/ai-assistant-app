/**
 * Analytics: delivered report files, who may see them, and what the platform
 * may show of them (docs/ANALYTICS_ADMIN_ASSESSMENT.md).
 *
 * Two containers, two owners. A third-party ETL writes the files into the
 * DELIVERY container; the app only reads them (and deletes at expiry). The
 * documents below — who may see which folder, which fields may be shown, what
 * the validator found — live in the ADMIN container, which the ETL cannot
 * write. Keeping the access rules out of the ETL's reach is the reason for
 * the split.
 *
 * ⚠ NO beta suffix, unlike limits/delegations/announcements. By decision beta
 * and prod share one tree, one audience set and one validation state: the
 * reports describe the same (shared, jointly charged) deployment. Two things
 * follow and both are load-bearing:
 *  - an audience edited on beta is live for prod users;
 *  - beta runs NEWER code against the same documents, so every schema here is
 *    `.passthrough()` and may only change in backward-compatible ways.
 *
 * Client-importable: no server-only imports.
 */
import { OverrideScopeSchema } from '@/lib/services/limits/types';

import { z } from 'zod';

const ANALYTICS_PREFIX = 'system/analytics/';
export const ANALYTICS_FOLDERS_PATH = `${ANALYTICS_PREFIX}folders.json`;
export const ANALYTICS_FOLDERS_HISTORY_PREFIX = `${ANALYTICS_PREFIX}folders-history/`;
export const ANALYTICS_FIELD_POLICY_PATH = `${ANALYTICS_PREFIX}field-policy.json`;
export const ANALYTICS_FIELD_POLICY_HISTORY_PREFIX = `${ANALYTICS_PREFIX}field-policy-history/`;
export const ANALYTICS_STATE_PATH = `${ANALYTICS_PREFIX}state.json`;
export const ANALYTICS_MAINTENANCE_CLAIM_PATH = `${ANALYTICS_PREFIX}claims/maintenance.json`;

/**
 * Format version of the stored previews. Lives in the PATH so beta (newer
 * code) and prod (older) sharing one container never read each other's
 * layout: a new format is a new folder, and the old one stays readable.
 */
export const ANALYTICS_PREVIEW_VERSION = 1;

export function analyticsPreviewPath(fileId: string): string {
  return `${ANALYTICS_PREFIX}derived/v${ANALYTICS_PREVIEW_VERSION}/${fileId}.json`;
}

/** The file's rollup (rollup.ts), beside its preview. */
export function analyticsRollupPath(fileId: string): string {
  return `${ANALYTICS_PREFIX}derived/v${ANALYTICS_PREVIEW_VERSION}/${fileId}.rollup.json`;
}

export function analyticsHistoryBlobPath(
  prefix: string,
  updatedAt: string,
  updatedBy: string,
): string {
  const stamp = updatedAt.replace(/[:.]/g, '-');
  const who = updatedBy.replace(/[^a-z0-9@._-]/gi, '_');
  return `${prefix}${stamp}_${who}.json`;
}

export const DEFAULT_RETENTION_MONTHS = 24;
export const MAX_RETENTION_MONTHS = 240;
export const MAX_ANALYTICS_FOLDERS = 500;
export const MAX_AUDIENCE_ENTRIES = 50;

/**
 * `view` — dashboards and aggregates. `download` — the file itself and
 * row-level tables. Ordered: download implies view.
 */
export const ANALYTICS_ACCESS_LEVELS = ['view', 'download'] as const;
export type AnalyticsAccessLevel = (typeof ANALYTICS_ACCESS_LEVELS)[number];

export const ANALYTICS_REPORT_TYPE_IDS = [
  'usage',
  'rebilling',
  'emissions',
  'raw-telemetry',
] as const;
export type AnalyticsReportTypeId = (typeof ANALYTICS_REPORT_TYPE_IDS)[number];

/** One OR'd audience term — the shared targeting vocabulary plus a level. */
export const AnalyticsAudienceEntrySchema = z
  .object({
    scope: OverrideScopeSchema,
    targets: z.array(z.string().max(320)).min(1),
    level: z.enum(ANALYTICS_ACCESS_LEVELS),
  })
  .passthrough();
export type AnalyticsAudienceEntry = z.infer<
  typeof AnalyticsAudienceEntrySchema
>;

/**
 * The overlay for one folder of the delivery container. The folder itself is
 * whatever path the ETL wrote to; this only says how to present it and who
 * may open it. A path with NO entry (and no ancestor granting access) is
 * visible to admins only, so new ETL output never reaches anyone by default.
 */
export const AnalyticsFolderSchema = z
  .object({
    /** Delivery-container path, no leading/trailing slash. '' is the root. */
    path: z.string().max(400),
    name: z.string().max(120).default(''),
    description: z.string().max(500).default(''),
    /** Inherited by descendants that do not set their own. */
    reportType: z.enum(ANALYTICS_REPORT_TYPE_IDS).nullable().default(null),
    /** OR'd. Empty = admins only (unless an ancestor grants). */
    audience: z
      .array(AnalyticsAudienceEntrySchema)
      .max(MAX_AUDIENCE_ENTRIES)
      .default([]),
    /** Stop inheriting audiences from ancestors. */
    restricted: z.boolean().default(false),
    /** null = inherit; the root default is DEFAULT_RETENTION_MONTHS. */
    retentionMonths: z
      .number()
      .int()
      .min(1)
      .max(MAX_RETENTION_MONTHS)
      .nullable()
      .default(null),
    /** Field ids hidden HERE on top of the platform policy (tighten only). */
    hiddenFields: z.array(z.string().max(60)).max(50).default([]),
  })
  .passthrough();
export type AnalyticsFolder = z.infer<typeof AnalyticsFolderSchema>;

export const AnalyticsFoldersDocumentSchema = z
  .object({
    version: z.literal(1),
    folders: z
      .array(AnalyticsFolderSchema)
      .max(MAX_ANALYTICS_FOLDERS)
      .default([]),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type AnalyticsFoldersDocument = z.infer<
  typeof AnalyticsFoldersDocumentSchema
>;

export const MAX_CLASSIFIED_COLUMNS = 500;

/**
 * Which fields the platform may show (design §6.4). Set on FIELDS, not column
 * names: `columns` maps a column the catalog does not know onto a field, and
 * `hidden` switches whole fields off platform-wide.
 */
export const AnalyticsFieldPolicyDocumentSchema = z
  .object({
    version: z.literal(1),
    hidden: z.array(z.string().max(60)).max(100).default([]),
    /** Normalized column name → field id. Bounded on read. */
    columns: z
      .record(z.string().max(200), z.string().max(60))
      .default({})
      .refine(
        (columns) => Object.keys(columns).length <= MAX_CLASSIFIED_COLUMNS,
        { message: 'Too many classified columns' },
      ),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type AnalyticsFieldPolicyDocument = z.infer<
  typeof AnalyticsFieldPolicyDocumentSchema
>;

export const ANALYTICS_ISSUE_SEVERITIES = ['info', 'warning', 'error'] as const;
export type AnalyticsIssueSeverity =
  (typeof ANALYTICS_ISSUE_SEVERITIES)[number];

/**
 * Stored codes come from the validator; the last two are computed when the
 * health view is read (they depend on the clock or the current policy).
 */
export const ANALYTICS_ISSUE_CODES = [
  'name-mismatch',
  'unsupported-format',
  'too-large',
  'empty-file',
  'unreadable',
  'identifier-column',
  'identifier-values',
  'user-code-format',
  'formulas-without-values',
  'missing-sheet',
  'missing-column',
  'no-period',
  'unclassified-field',
  'past-retention',
] as const;
export type AnalyticsIssueCode = (typeof ANALYTICS_ISSUE_CODES)[number];

export const AnalyticsIssueSchema = z
  .object({
    /** A plain string on read so an older replica tolerates a newer code. */
    code: z.string().max(60),
    severity: z.enum(ANALYTICS_ISSUE_SEVERITIES),
    /** Interpolated into the translated message; never contains cell values. */
    params: z
      .record(z.string(), z.union([z.string().max(300), z.number()]))
      .default({}),
  })
  .passthrough();
export type AnalyticsIssue = z.infer<typeof AnalyticsIssueSchema>;

export const ANALYTICS_FILE_STATUSES = ['ok', 'warning', 'error'] as const;
export type AnalyticsFileStatus = (typeof ANALYTICS_FILE_STATUSES)[number];

/** What the validator found in one delivered file, keyed to its version. */
export const AnalyticsFileStateSchema = z
  .object({
    path: z.string().max(1024),
    /** `${size}:${lastModified}` of the blob this was computed from. */
    blobVersion: z.string().max(100),
    validatorVersion: z.number().int(),
    validatedAt: z.string(),
    /** When a problem was first recorded for this path (kept across re-runs). */
    firstSeenAt: z.string(),
    status: z.enum(ANALYTICS_FILE_STATUSES),
    issues: z.array(AnalyticsIssueSchema).max(60).default([]),
    /**
     * Distinct header names of the TEXT columns found. Classified against the
     * field policy when READ, so a policy change needs no re-validation.
     */
    columns: z.array(z.string().max(200)).max(300).default([]),
    /** Field ids a report type declares for its laid-out sheets. */
    declaredFields: z.array(z.string().max(60)).max(50).default([]),
    /** False when the contents could not be opened (unsupported, too large). */
    inspected: z.boolean().default(false),
    /**
     * The report type in force when this was computed. A folder's type decides
     * the expected name and which sheets are laid-out pages, so changing it
     * invalidates the record.
     */
    reportType: z.string().max(60).nullable().default(null),
    /**
     * Format version of the stored preview written alongside this record;
     * null when there is none (raw, quarantined, or it could not be written).
     */
    previewVersion: z.number().int().nullable().default(null),
    /**
     * Version of the stored rollup written alongside this record; null when
     * there is none (no report type, raw, quarantined, or it failed).
     */
    rollupVersion: z.number().int().nullable().default(null),
  })
  .passthrough();
export type AnalyticsFileState = z.infer<typeof AnalyticsFileStateSchema>;

/**
 * One document for every file's state. At two years of deliveries (~2,000
 * files, a few hundred bytes each) it stays well under a megabyte; if the
 * delivery volume grows by an order of magnitude, partition it by top-level
 * folder.
 */
export const AnalyticsStateDocumentSchema = z
  .object({
    version: z.literal(1),
    /** Keyed by file id (see `analyticsFileId`). */
    files: z.record(z.string(), AnalyticsFileStateSchema).default({}),
    updatedAt: z.string(),
  })
  .passthrough();
export type AnalyticsStateDocument = z.infer<
  typeof AnalyticsStateDocumentSchema
>;

export const AnalyticsHistoryEntrySchema = z.object({
  version: z.literal(1),
  document: z.unknown(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AnalyticsHistoryEntry = z.infer<typeof AnalyticsHistoryEntrySchema>;

/** A blob in the delivery container, as the listing reports it. */
export interface DeliveredBlob {
  path: string;
  size: number;
  lastModified: string;
}

export function blobVersionOf(blob: DeliveredBlob): string {
  return `${blob.size}:${blob.lastModified}`;
}
