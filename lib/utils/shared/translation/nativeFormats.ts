/**
 * The source formats Preserve formatting translates, and what each one is.
 *
 * A run's format is the kind of its stored source (`<sha256>.<format>`, see
 * nativeRunStorage.ts), so it is recorded with the run and read back from
 * the `sourceId` every later request sends. A `.ppt` is never a run's
 * format: it is converted to `.pptx` before the run starts.
 */

/** Presentation packages a run can be made from. */
export const NATIVE_DECK_FORMATS = ['pptx', 'pptm', 'ppsx', 'potx'] as const;

/** Every format a run's source can have. */
export const NATIVE_SOURCE_FORMATS = ['pdf', ...NATIVE_DECK_FORMATS] as const;

export type NativeDeckFormat = (typeof NATIVE_DECK_FORMATS)[number];
export type NativeSourceFormat = (typeof NATIVE_SOURCE_FORMATS)[number];

/** File extensions a Preserve formatting upload may have; `.ppt` is converted. */
export const NATIVE_UPLOAD_EXTENSIONS = [
  ...NATIVE_SOURCE_FORMATS,
  'ppt',
] as const;

/** Content type a run's source is stored and served with, by format. */
export const NATIVE_SOURCE_CONTENT_TYPES: Record<NativeSourceFormat, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
};

/** Whether a value is a run source format. */
export function isNativeSourceFormat(
  value: unknown,
): value is NativeSourceFormat {
  return (
    typeof value === 'string' &&
    (NATIVE_SOURCE_FORMATS as readonly string[]).includes(value)
  );
}

/** Whether a format is a presentation. */
export function isNativeDeckFormat(value: unknown): value is NativeDeckFormat {
  return (
    typeof value === 'string' &&
    (NATIVE_DECK_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * The format of a stored source, from its file id (`<sha256>.<format>`).
 *
 * @returns The format, or null when the id does not name a source.
 */
export function nativeFormatOfFileId(
  fileId: unknown,
): NativeSourceFormat | null {
  if (typeof fileId !== 'string') return null;
  const kind = fileId.slice(fileId.lastIndexOf('.') + 1);
  return isNativeSourceFormat(kind) ? kind : null;
}

/**
 * The extension of an upload's file name, lowercased, when Preserve
 * formatting accepts it.
 *
 * @returns The extension (`ppt` included), or null for anything else.
 */
export function nativeUploadExtension(
  filename: string,
): (typeof NATIVE_UPLOAD_EXTENSIONS)[number] | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return (NATIVE_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as (typeof NATIVE_UPLOAD_EXTENSIONS)[number])
    : null;
}

/**
 * The largest presentation translated with its formatting kept, or laid out
 * as slides for the setup (bytes).
 */
export const NATIVE_DECK_MAX_BYTES = 60 * 1024 * 1024;

/** Whether an upload is translated as a presentation (`.ppt` included). */
export function isNativeDeckUpload(filename: string): boolean {
  const extension = nativeUploadExtension(filename);
  return extension !== null && extension !== 'pdf';
}

/**
 * A file name with the extension of the format it is stored in, which
 * differs for a `.ppt` (stored converted, as `.pptx`).
 *
 * @example storedFileName('Budget.ppt', 'pptx') // 'Budget.pptx'
 */
export function storedFileName(
  filename: string,
  format: NativeSourceFormat,
): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}.${format}`;
}
