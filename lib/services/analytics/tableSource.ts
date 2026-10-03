/**
 * Where a file's tables come from when someone opens or exports it.
 * Server-only.
 */
import { getPayloadCache } from '@/lib/services/agentAccess/payloadCache';
import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { FolderIndex } from '@/lib/services/analytics/access';
import {
  extractTables,
  isReadableExtension,
} from '@/lib/services/analytics/extract';
import { runHeavy } from '@/lib/services/analytics/heavyWork';
import {
  extensionOf,
  folderOfFile,
  isRawPath,
} from '@/lib/services/analytics/paths';
import { readPreview } from '@/lib/services/analytics/previewStore';
import { effectiveReportType } from '@/lib/services/analytics/reportTypes';
import { FileRollup } from '@/lib/services/analytics/rollup';
import { buildRollup } from '@/lib/services/analytics/rollupBuild';
import { readRollup } from '@/lib/services/analytics/rollupStore';
import { DerivedTable } from '@/lib/services/analytics/tables';
import { FileView } from '@/lib/services/analytics/viewModel';

/** Rows of a raw telemetry file shown in the app. */
export const RAW_PREVIEW_ROWS = 1000;

/**
 * The capped tables for the preview grid.
 *
 * Reports come from the stored preview. Raw telemetry has none by design (it
 * would be a second copy of names and addresses in another container), so it
 * is read from the delivery container when a global admin opens it; the
 * parsed rows are kept only in this replica's memory cache.
 */
export async function loadPreviewTables(
  service: AnalyticsService,
  file: FileView,
): Promise<DerivedTable[] | null> {
  if (!isRawPath(file.path)) {
    return readPreview(service.getAdminStorage(), file.id, file.blobVersion);
  }
  const extension = extensionOf(file.path);
  if (!isReadableExtension(extension)) return null;
  const entry = await getPayloadCache().getOrLoadImmutable<DerivedTable[]>(
    `analytics-raw:${file.id}:${file.blobVersion}`,
    async () => {
      const content = await service.getDeliveryStore().download(file.path);
      if (content === null) return null;
      const tables = await extractTables(content, extension, {
        maxRows: RAW_PREVIEW_ROWS,
      });
      return { value: tables, bytes: JSON.stringify(tables).length };
    },
  );
  return entry?.value ?? null;
}

/**
 * The file's rollup. Reports have one stored. Raw telemetry is aggregated
 * from the delivered parquet when a global admin opens it — the aggregates
 * hold no names, but the file is not processed at delivery, so there is
 * nothing stored to read.
 */
export async function loadRollup(
  service: AnalyticsService,
  file: FileView,
): Promise<FileRollup | null> {
  if (!isRawPath(file.path)) {
    return readRollup(service.getAdminStorage(), file.id, file.blobVersion);
  }
  const extension = extensionOf(file.path);
  if (!isReadableExtension(extension)) return null;
  const entry = await getPayloadCache().getOrLoadImmutable<FileRollup>(
    `analytics-raw-rollup:${file.id}:${file.blobVersion}`,
    async () => {
      const content = await service.getDeliveryStore().download(file.path);
      if (content === null) return null;
      const tables = await runHeavy(() =>
        extractTables(content, extension, {
          maxRows: Number.POSITIVE_INFINITY,
        }),
      );
      const rollup = buildRollup('raw-telemetry', file.blobVersion, tables);
      return { value: rollup, bytes: JSON.stringify(rollup).length };
    },
  );
  return entry?.value ?? null;
}

/**
 * Every row of the file (or of one sheet), read from the delivered bytes.
 * Expensive for a large workbook, so it queues behind other heavy work and
 * is refused outright when the queue is already long.
 *
 * @throws AnalyticsBusyError when too many exports are waiting.
 */
export async function loadFullTables(
  service: AnalyticsService,
  file: FileView,
  folders: FolderIndex,
  onlySheet?: string,
): Promise<DerivedTable[] | null> {
  const extension = extensionOf(file.path);
  if (!isReadableExtension(extension)) return null;
  const reportType = effectiveReportType(folderOfFile(file.path), folders);
  return runHeavy(
    async () => {
      const content = await service.getDeliveryStore().download(file.path);
      if (content === null) return null;
      return extractTables(content, extension, {
        maxRows: Number.POSITIVE_INFINITY,
        freeformSheets: reportType?.freeformSheets,
        ...(onlySheet !== undefined && extension === 'xlsx'
          ? { onlySheets: [onlySheet] }
          : {}),
      });
    },
    { shed: true },
  );
}
