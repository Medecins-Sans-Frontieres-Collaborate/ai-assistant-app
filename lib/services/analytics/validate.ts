/**
 * Validates one delivered file (design §5). Server-only (opens the file).
 *
 * The outcome is what the admin health panel shows and what decides whether
 * anyone else sees the file:
 *  - `error`   → hidden from everyone but admins. A failed anonymization
 *                check lands here and is non-negotiable: fail closed.
 *  - `warning` → visible; the admin is told what is off.
 *  - `ok`.
 *
 * It also returns the tables it read, so the stored preview is written from
 * the same pass rather than a second parse.
 *
 * Never throws for a bad FILE: an unexpected parser failure becomes an
 * `unreadable` error in the record, not a broken page.
 */
import { FolderIndex } from '@/lib/services/analytics/access';
import {
  ReadableExtension,
  extractTables,
  isReadableExtension,
} from '@/lib/services/analytics/extract';
import { normalizeColumnName } from '@/lib/services/analytics/fields';
import { VALIDATOR_VERSION } from '@/lib/services/analytics/fileState';
import {
  ContentScan,
  InspectedSheet,
  InspectionTooLargeError,
  inspectTables,
  scanCsv,
  scanParquet,
  scanXlsx,
} from '@/lib/services/analytics/inspect';
import {
  baseName,
  extensionOf,
  folderOfFile,
  isRawPath,
} from '@/lib/services/analytics/paths';
import {
  ReportTypeDefinition,
  effectiveReportType,
} from '@/lib/services/analytics/reportTypes';
import { periodOfFileName } from '@/lib/services/analytics/retention';
import { FileRollup } from '@/lib/services/analytics/rollup';
import {
  ROLLUP_FULL_SHEETS,
  buildRollup,
} from '@/lib/services/analytics/rollupBuild';
import { DerivedTable, PREVIEW_ROWS } from '@/lib/services/analytics/tables';
import {
  AnalyticsFileState,
  AnalyticsFileStatus,
  AnalyticsIssue,
  AnalyticsIssueCode,
  AnalyticsIssueSeverity,
  DeliveredBlob,
  blobVersionOf,
} from '@/lib/services/analytics/types';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/** Largest non-raw file the validator will download and open. */
export const MAX_INSPECT_BYTES = 25 * 1024 * 1024;

function issue(
  code: AnalyticsIssueCode,
  severity: AnalyticsIssueSeverity,
  params: Record<string, string | number> = {},
): AnalyticsIssue {
  return { code, severity, params };
}

function statusOf(issues: readonly AnalyticsIssue[]): AnalyticsFileStatus {
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'ok';
}

/** Whether the validator needs the file's bytes at all. */
export function needsContent(blob: DeliveredBlob): boolean {
  return (
    !isRawPath(blob.path) &&
    blob.size > 0 &&
    blob.size <= MAX_INSPECT_BYTES &&
    isReadableExtension(extensionOf(blob.path))
  );
}

function anonymizationIssues(
  sheets: readonly InspectedSheet[],
  scan: ContentScan,
): AnalyticsIssue[] {
  const issues: AnalyticsIssue[] = [];
  for (const sheet of sheets) {
    for (const column of sheet.identifierColumns) {
      issues.push(
        issue('identifier-column', 'error', { sheet: sheet.name, column }),
      );
    }
    for (const bad of sheet.badUserCodes) {
      issues.push(
        issue('user-code-format', 'error', {
          sheet: sheet.name,
          column: bad.column,
          count: bad.count,
        }),
      );
    }
  }
  for (const hit of scan.emailHits) {
    issues.push(
      issue('identifier-values', 'error', {
        sheet: hit.where,
        count: hit.count,
      }),
    );
  }
  return issues;
}

/** What the report type requires and the workbook lacks. */
function structureIssues(
  reportType: ReportTypeDefinition | null,
  sheets: readonly InspectedSheet[],
): AnalyticsIssue[] {
  if (!reportType) return [];
  const issues: AnalyticsIssue[] = [];
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  for (const [name, columns] of Object.entries(reportType.requiredSheets)) {
    const sheet = byName.get(name);
    if (!sheet) {
      issues.push(issue('missing-sheet', 'warning', { sheet: name }));
      continue;
    }
    const present = new Set(sheet.headers.map(normalizeColumnName));
    for (const column of columns) {
      if (!present.has(normalizeColumnName(column))) {
        issues.push(
          issue('missing-column', 'warning', { sheet: name, column }),
        );
      }
    }
  }
  return issues;
}

export interface ValidateInput {
  blob: DeliveredBlob;
  /** The file's bytes when {@link needsContent} said so; null otherwise. */
  content: Buffer | null;
  folders: FolderIndex;
  /** The previous record for this path, to keep `firstSeenAt`. */
  previous?: AnalyticsFileState | null;
  now: Date;
}

export interface ValidateResult {
  state: AnalyticsFileState;
  /**
   * The capped tables read from the file, for the stored preview. Null when
   * the file was not opened or must not be previewed (raw, quarantined).
   */
  tables: DerivedTable[] | null;
  /**
   * The aggregates its dashboard is drawn from. Null when the folder names no
   * report type, the file is quarantined, or building them failed.
   */
  rollup: FileRollup | null;
}

/**
 * Largest sheet a rollup will read in full. Above it the datasets built from
 * that sheet are left out rather than computed from a partial read.
 */
export const MAX_ROLLUP_ROWS = 250_000;

/**
 * The file's tables with the sheets its rollup needs read IN FULL. The capped
 * read is reused wherever it already holds every row; a sheet too large to
 * read is dropped, so nothing is ever aggregated from a partial table.
 */
async function tablesForRollup(
  content: Buffer,
  extension: ReadableExtension,
  reportType: ReportTypeDefinition,
  capped: readonly DerivedTable[],
): Promise<DerivedTable[]> {
  const needed = new Set(ROLLUP_FULL_SHEETS[reportType.id]);
  const partial = capped.filter(
    (table) => needed.has(table.name) && table.truncated,
  );
  const readable = partial
    .filter((table) => table.rowCount <= MAX_ROLLUP_ROWS)
    .map((table) => table.name);
  const full =
    readable.length > 0 && extension === 'xlsx'
      ? await extractTables(content, extension, {
          maxRows: Number.POSITIVE_INFINITY,
          freeformSheets: reportType.freeformSheets,
          onlySheets: readable,
        })
      : [];
  const fullByName = new Map(full.map((table) => [table.name, table]));
  return capped
    .filter((table) => !partial.includes(table) || fullByName.has(table.name))
    .map((table) => fullByName.get(table.name) ?? table);
}

export async function validateDelivery(
  input: ValidateInput,
): Promise<ValidateResult> {
  const { blob, content, folders, previous, now } = input;
  const name = baseName(blob.path);
  const extension = extensionOf(blob.path);
  const raw = isRawPath(blob.path);
  const reportType = effectiveReportType(folderOfFile(blob.path), folders);
  const issues: AnalyticsIssue[] = [];
  const columns = new Set<string>();
  const declaredFields = new Set<string>();
  let tables: DerivedTable[] | null = null;
  let rollup: FileRollup | null = null;
  let inspected = false;

  const tooLarge = () =>
    issue('too-large', 'error', {
      sizeMb: Math.round((blob.size / (1024 * 1024)) * 10) / 10,
      limitMb: MAX_INSPECT_BYTES / (1024 * 1024),
    });

  if (reportType && !reportType.fileNamePattern.test(name)) {
    issues.push(
      issue('name-mismatch', 'warning', {
        expected: reportType.fileNameExample,
      }),
    );
  }
  if (periodOfFileName(name) === null) {
    issues.push(issue('no-period', 'info'));
  }

  if (blob.size === 0) {
    issues.push(issue('empty-file', 'error'));
  } else if (raw) {
    // Raw telemetry is global-admin only and is not opened here: there is
    // nothing to anonymize-check. It is read on demand when an admin opens it.
  } else if (!isReadableExtension(extension)) {
    // Outside raw/, a file the validator cannot open cannot be vouched for.
    issues.push(
      issue('unsupported-format', 'error', {
        extension: extension || '(none)',
      }),
    );
  } else if (blob.size > MAX_INSPECT_BYTES || content === null) {
    issues.push(tooLarge());
  } else {
    try {
      // The full-content scan runs first: for a workbook it also enforces the
      // inflate limit before the parser touches the file.
      const scan =
        extension === 'xlsx'
          ? scanXlsx(content)
          : extension === 'csv'
            ? scanCsv(content)
            : await scanParquet(content);
      const read = await extractTables(content, extension, {
        maxRows: PREVIEW_ROWS,
        freeformSheets: reportType?.freeformSheets,
      });
      const sheets = inspectTables(read);
      inspected = true;
      issues.push(...anonymizationIssues(sheets, scan));
      for (const sheet of sheets) {
        for (const column of sheet.textColumns) columns.add(column);
      }
      for (const table of read) {
        for (const field of table.declaredFields) declaredFields.add(field);
      }
      for (const entry of scan.formulasWithoutValues) {
        issues.push(
          issue('formulas-without-values', 'warning', {
            sheet: entry.sheet,
            count: entry.count,
          }),
        );
      }
      if (extension === 'xlsx') {
        issues.push(...structureIssues(reportType, sheets));
      }
      tables = read;
      if (reportType && statusOf(issues) !== 'error') {
        try {
          rollup = buildRollup(
            reportType.id,
            blobVersionOf(blob),
            await tablesForRollup(content, extension, reportType, read),
          );
        } catch (error) {
          // The file is fine; only its dashboard is missing.
          console.warn(
            `[analytics] could not build the rollup of ${sanitizeForLog(blob.path)}: ${sanitizeForLog(error)}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof InspectionTooLargeError) {
        issues.push(tooLarge());
      } else {
        console.warn(
          `[analytics] could not open ${sanitizeForLog(blob.path)}: ${sanitizeForLog(error)}`,
        );
        issues.push(issue('unreadable', 'error'));
      }
    }
  }

  const status = statusOf(issues);
  const nowIso = now.toISOString();
  return {
    state: {
      path: blob.path,
      blobVersion: blobVersionOf(blob),
      validatorVersion: VALIDATOR_VERSION,
      validatedAt: nowIso,
      // The clock for "how long has this been wrong" survives re-validation
      // of a file that is still wrong, and restarts once it has been clean.
      firstSeenAt:
        previous && previous.status !== 'ok' && status !== 'ok'
          ? previous.firstSeenAt
          : nowIso,
      status,
      issues: issues.slice(0, 60),
      columns: [...columns].slice(0, 300),
      declaredFields: [...declaredFields],
      // Raw files are never opened here and never need to be: the field
      // policy does not apply to them.
      inspected: inspected || raw,
      reportType: reportType?.id ?? null,
      // Both set by the caller once they have actually been stored.
      previewVersion: null,
      rollupVersion: null,
    },
    // A quarantined file gets no preview: nothing of it should be stored a
    // second time, and nobody but an admin could open it anyway.
    tables: status === 'error' ? null : tables,
    rollup: status === 'error' ? null : rollup,
  };
}
