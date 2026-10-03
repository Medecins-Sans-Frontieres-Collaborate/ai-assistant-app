/**
 * The checks every "open this file" route shares: find the file by id, make
 * sure the caller may see it, and work out what they may see OF it.
 * Server-only.
 */
import {
  FolderAccess,
  resolveFolderAccess,
} from '@/lib/services/analytics/access';
import { effectiveHiddenFields } from '@/lib/services/analytics/fields';
import { PreviewContext } from '@/lib/services/analytics/previewModel';
import { AnalyticsRequestContext } from '@/lib/services/analytics/requestContext';
import { FileView, isFileVisible } from '@/lib/services/analytics/viewModel';

export const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface ResolvedFile {
  file: FileView;
  access: FolderAccess;
  preview: PreviewContext;
}

/**
 * Null when the id names no file the caller can see — the same answer for
 * "does not exist" and "not yours", so the id is not an existence oracle.
 */
export function resolveVisibleFile(
  context: AnalyticsRequestContext,
  id: string,
): ResolvedFile | null {
  const file = context.files.find((candidate) => candidate.id === id);
  if (!file) return null;
  const access = resolveFolderAccess(
    file.folder,
    context.folders,
    context.actor,
  );
  if (!isFileVisible(file, access)) return null;
  return {
    file,
    access,
    preview: {
      access,
      hidden: effectiveHiddenFields(
        file.folder,
        context.folders,
        context.data.policy,
      ),
      policy: context.data.policy,
    },
  };
}
