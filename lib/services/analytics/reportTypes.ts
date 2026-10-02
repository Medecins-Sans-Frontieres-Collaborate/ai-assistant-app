/**
 * The report types the delivery contract defines
 * (docs/ANALYTICS_DELIVERY_CONTRACT.md). Pure and client-importable.
 *
 * A folder names its type; descendants inherit it. The type supplies what the
 * validator checks a delivery against: the expected file name, how often one
 * is expected, and which sheets are laid-out pages rather than tables.
 *
 * File-name patterns live HERE, in code, on purpose: an admin-supplied regular
 * expression evaluated on every listing would be a ReDoS foothold.
 */
import { FolderIndex } from '@/lib/services/analytics/access';
import { AnalyticsFieldId } from '@/lib/services/analytics/fields';
import { folderChain } from '@/lib/services/analytics/paths';
import { AnalyticsReportTypeId } from '@/lib/services/analytics/types';

export type DeliveryCadence = 'daily' | 'monthly';

export interface ReportTypeDefinition {
  id: AnalyticsReportTypeId;
  /** Matched against the file's base name. */
  fileNamePattern: RegExp;
  /** Shown to admins when a name does not match. */
  fileNameExample: string;
  cadence: DeliveryCadence;
  /**
   * Sheets that are laid-out pages (title rows, stacked sub-tables) and
   * cannot be read as one table. Their columns are not scanned; the fields
   * they contain are declared instead.
   */
  freeformSheets: Readonly<Record<string, readonly AnalyticsFieldId[]>>;
  /**
   * Sheets the report must have, each with the columns the dashboards read.
   * A freeform sheet lists no columns: only its presence is checked. A
   * shortfall is a warning — the file stays downloadable, the views that
   * need the missing piece do not render.
   */
  requiredSheets: Readonly<Record<string, readonly string[]>>;
}

export const REPORT_TYPES: Record<AnalyticsReportTypeId, ReportTypeDefinition> =
  {
    usage: {
      id: 'usage',
      fileNamePattern:
        /^[a-z0-9][a-z0-9-]*_report_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.xlsx$/i,
      fileNameExample: 'ocba_report_2026-07-01_to_2026-07-31.xlsx',
      cadence: 'monthly',
      freeformSheets: {},
      requiredSheets: {
        Summary: ['slice', 'unique_users', 'interactions'],
        Users: ['UserId', 'total_interactions', 'days_active'],
        Daily: ['date', 'unique_users', 'interactions'],
        Weekly: ['week_start', 'unique_users', 'interactions'],
        Interactions: ['UserId', 'ModelUsed', 'event_date'],
      },
    },
    rebilling: {
      id: 'rebilling',
      fileNamePattern: /^MS Azure rebilling_\d{4}-\d{2}\.xlsx$/i,
      fileNameExample: 'MS Azure rebilling_2026-07.xlsx',
      cadence: 'monthly',
      freeformSheets: {},
      requiredSheets: {
        Allocation: ['Section', 'Usage events', 'Billed', 'Currency'],
        Reconciliation: ['Line', 'Amount'],
        Attribution: ['Section', 'Mail domain', 'Usage events', 'Users'],
        Changes: ['Section', 'Previous file', 'Restated', 'Change'],
      },
    },
    emissions: {
      id: 'emissions',
      fileNamePattern: /^emissions_report_\d{4}-\d{2}_[A-Za-z0-9][\w-]*\.xlsx$/,
      fileNameExample: 'emissions_report_2026-09_MSF-Germany.xlsx',
      cadence: 'monthly',
      freeformSheets: {
        Summary: ['department', 'technical'],
        Assumptions: ['technical'],
      },
      requiredSheets: {
        Summary: [],
        Assumptions: [],
        'Usage detail': [
          'User code',
          'Department',
          'Model',
          'Size class',
          'Region',
          'Requests',
          'Prompt tokens',
          'Completion tokens',
        ],
      },
    },
    'raw-telemetry': {
      id: 'raw-telemetry',
      fileNamePattern: /^\d{4}-\d{2}-\d{2}\.parquet$/,
      fileNameExample: '2026-09-26.parquet',
      cadence: 'daily',
      freeformSheets: {},
      requiredSheets: {},
    },
  };

/**
 * Days after the newest delivered period ends before a folder counts as
 * stale. Monthly reports arrive early in the following month, so the next
 * one is overdue once a month and a half has passed.
 */
export const STALE_AFTER_DAYS: Record<DeliveryCadence, number> = {
  daily: 3,
  monthly: 45,
};

/** The nearest ancestor's report type, or null. */
export function effectiveReportType(
  folderPath: string,
  folders: FolderIndex,
): ReportTypeDefinition | null {
  for (const path of folderChain(folderPath)) {
    const id = folders.get(path)?.reportType;
    if (id) return REPORT_TYPES[id] ?? null;
  }
  return null;
}
