/**
 * "Material" detection for the structured-extraction guided flow.
 *
 * Extraction requires something to operate on — pasted text, attached
 * files, or active files carried over from prior turns. The composer
 * tray shows a warning + disables send when nothing qualifies; the
 * with-material state shows what will be extracted.
 *
 * URL detection is intentionally not handled here. A URL pasted into
 * the textarea already shows up as text (hasText becomes true). Server-
 * side `ExtractionEnricher` handles URL fetching once material reaches
 * the pipeline.
 */

export interface ExtractionMaterialSources {
  /** Raw textarea value. Trimmed internally before non-emptiness check. */
  textFieldValue: string;
  /** Files in the current composer (`filePreviews.length`). */
  filePreviewCount: number;
  /** Active files carried over from prior turns. */
  activeFileCount: number;
}

export interface ExtractionMaterialState {
  hasText: boolean;
  newFileCount: number;
  activeFileCount: number;
  hasAny: boolean;
}

export function getExtractionMaterialState(
  sources: ExtractionMaterialSources,
): ExtractionMaterialState {
  const hasText = sources.textFieldValue.trim().length > 0;
  const newFileCount = Math.max(0, sources.filePreviewCount);
  const activeFileCount = Math.max(0, sources.activeFileCount);
  const hasAny = hasText || newFileCount > 0 || activeFileCount > 0;
  return { hasText, newFileCount, activeFileCount, hasAny };
}
