/**
 * Whether a stored validation record still describes a delivered file. Pure
 * and free of the validator's parser imports, so the view model can use it.
 */
import { FolderIndex } from '@/lib/services/analytics/access';
import { folderOfFile } from '@/lib/services/analytics/paths';
import { effectiveReportType } from '@/lib/services/analytics/reportTypes';
import {
  AnalyticsFileState,
  DeliveredBlob,
  blobVersionOf,
} from '@/lib/services/analytics/types';

/**
 * Bump when a check is added or tightened: files validated by an OLDER
 * version are re-validated. Never re-validates downward, so beta (newer code)
 * and prod (older) sharing one state document do not fight over it.
 */
export const VALIDATOR_VERSION = 3;

/**
 * A stored record still describes this blob: same bytes, a validator at least
 * as new, and the same report type in force for its folder.
 */
export function isStateCurrent(
  state: AnalyticsFileState | undefined,
  blob: DeliveredBlob,
  folders: FolderIndex,
): state is AnalyticsFileState {
  return (
    state !== undefined &&
    state.blobVersion === blobVersionOf(blob) &&
    state.validatorVersion >= VALIDATOR_VERSION &&
    state.reportType ===
      (effectiveReportType(folderOfFile(blob.path), folders)?.id ?? null)
  );
}
