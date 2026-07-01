/**
 * Shared file type constants used across the application.
 * Centralized to ensure consistency and easy maintenance.
 */

/**
 * Audio and video file extensions supported for transcription.
 *
 * The formats Whisper natively accepts are listed in {@link WHISPER_NATIVE_EXTENSIONS};
 * everything else here is routed through FFmpeg audio extraction first (see
 * FileProcessor and the legacy /api/file/[id]/transcribe route). The splitter
 * (audioSplitter) and extractor (audioExtractor) rely on ffmpeg/ffprobe being
 * able to decode the container — ffmpeg-static bundles the common decoders
 * (AAC, MP3, Opus, Vorbis, FLAC, ALAC).
 *
 * Regression note (issue #90): `.m4v` was previously missing from this list,
 * so an uploaded `.m4v` fell into the document branch and surfaced a generic
 * "unable to process the uploaded file" error. The magic-byte signature
 * table already recognized it; only this extension allowlist was the gate.
 */
export const AUDIO_VIDEO_EXTENSIONS = [
  // Whisper-native formats (sent directly, no transcoding)
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
  // Video containers — audio extracted via FFmpeg before Whisper
  '.m4v',
  '.mkv',
  '.mov',
  '.avi',
  '.flv',
  '.wmv',
  // Audio containers Whisper doesn't accept — transcoded to mp3 via FFmpeg
  '.ogg',
  '.oga',
  '.flac',
  '.aac',
  '.opus',
  '.3gp',
  '.ts',
] as const;

/**
 * Formats the Whisper API accepts directly without transcoding. Anything in
 * {@link AUDIO_VIDEO_EXTENSIONS} that is NOT in this set must be passed
 * through FFmpeg audio extraction (to mp3) before being sent to Whisper.
 *
 * Source: https://platform.openai.com/docs/guides/speech-to-text#supported-languages
 * (mp3, mp4, mpeg, mpga, m4a, wav, webm).
 */
export const WHISPER_NATIVE_EXTENSIONS = [
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
] as const;

/**
 * MIME types for audio files
 */
export const AUDIO_MIME_TYPES = ['audio/'] as const;

/**
 * MIME types for video files
 */
export const VIDEO_MIME_TYPES = ['video/'] as const;

/**
 * Checks if a filename has an audio/video extension
 */
export function isAudioVideoFile(filename: string): boolean {
  if (!filename) return false;

  const parts = filename.split('.');
  if (parts.length < 2) return false;

  const ext = '.' + parts.pop()?.toLowerCase();
  return AUDIO_VIDEO_EXTENSIONS.includes(ext as any);
}

/**
 * Checks if a file is in a format Whisper accepts natively (no transcoding
 * needed). Used to decide whether FFmpeg audio extraction is required
 * before sending the file to the Whisper API. Returns false for video
 * containers (mp4 included — `.mp4` is technically Whisper-native, but a
 * video mp4 still benefits from audio-only extraction to cut payload size;
 * callers that want strict Whisper-native detection should use this, while
 * the FileProcessor keeps its own `isVideo` branch for the size-aware path).
 */
export function isWhisperNativeFormat(filename: string): boolean {
  if (!filename) return false;

  const parts = filename.split('.');
  if (parts.length < 2) return false;

  const ext = '.' + parts.pop()?.toLowerCase();
  return WHISPER_NATIVE_EXTENSIONS.includes(ext as any);
}

/**
 * Checks if a file is audio/video based on filename or MIME type
 */
export function isAudioVideoFileByTypeOrName(
  filename: string,
  mimeType?: string,
): boolean {
  // Check MIME type first
  if (mimeType) {
    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      return true;
    }
  }

  // Fall back to extension check
  return isAudioVideoFile(filename);
}

/**
 * Accept attribute value for file inputs that accept audio/video for transcription.
 * Includes MIME type wildcards and explicit extensions for browser compatibility.
 */
export const TRANSCRIPTION_ACCEPT_TYPES =
  'audio/*,video/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm,.m4v,.mkv,.mov,.avi,.flv,.wmv,.ogg,.oga,.flac,.aac,.opus,.3gp,.ts';

/**
 * Accept attribute value for image file inputs.
 */
export const IMAGE_ACCEPT_TYPES = 'image/*';

/**
 * Accept attribute value for document + code file inputs (everything we parse
 * server-side that isn't an image or A/V file).
 */
export const DOCUMENT_AND_CODE_ACCEPT_TYPES =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.xml,.yaml,.yml,' +
  '.py,.js,.ts,.jsx,.tsx,.java,.c,.cpp,.cs,.go,.rb,.php,.sql,.sh,.bash,.ps1,.r,' +
  '.swift,.kt,.rs,.scala,.env,.config,.ini,.toml';

/**
 * Accept attribute value for the generic "attach any file" inputs. By
 * construction a superset of {@link TRANSCRIPTION_ACCEPT_TYPES} — attaching
 * should always offer at least every format the transcribe flow accepts.
 */
export const ATTACH_ACCEPT_TYPES = [
  IMAGE_ACCEPT_TYPES,
  DOCUMENT_AND_CODE_ACCEPT_TYPES,
  TRANSCRIPTION_ACCEPT_TYPES,
].join(',');

/**
 * Document file extensions supported for Azure Document Translation.
 * These formats support synchronous single-file translation.
 */
export const DOCUMENT_TRANSLATION_EXTENSIONS = [
  '.txt',
  '.html',
  '.htm',
  '.docx',
  '.xlsx',
  '.pptx',
  '.msg',
  '.xlf',
  '.xliff',
  '.csv',
  '.tsv',
  '.tab',
  '.mhtml',
  '.mht',
] as const;

/**
 * Glossary file extensions supported for document translation.
 */
export const GLOSSARY_EXTENSIONS = ['.csv', '.tsv', '.xlf', '.xliff'] as const;

/**
 * MIME types recognized as translatable documents. Used both to build the file
 * input `accept` value and as an OR fallback to the extension check, so an
 * upload whose extension is missing/unusual but whose MIME type is recognized is
 * still accepted. Browser-supplied MIME is unreliable for the obscure formats
 * (`.msg`, `.xlf`, `.tab`, `.mhtml`) — extension remains the primary signal and
 * this is only an additive safety net.
 */
export const DOCUMENT_TRANSLATION_MIME_TYPES = [
  'text/plain',
  'text/html',
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.ms-outlook', // .msg
  'application/xliff+xml', // .xlf/.xliff
  'application/x-xliff+xml', // .xlf/.xliff (legacy)
] as const;

/**
 * Accept attribute value for file inputs that accept documents for translation.
 *
 * Includes resolvable MIME types alongside the extension tokens. Several of the
 * supported extensions are obscure (`.msg`, `.tab`, `.mhtml`); an extension-only
 * `accept` with no MIME types Chrome can map to OS file types has been observed
 * to make the native file dialog fail to open on macOS Chrome. Pairing them with
 * real MIME types keeps the dialog reliable while the extensions still filter.
 */
export const DOCUMENT_TRANSLATION_ACCEPT_TYPES = [
  ...DOCUMENT_TRANSLATION_MIME_TYPES,
  ...DOCUMENT_TRANSLATION_EXTENSIONS,
].join(',');

/**
 * Accept attribute value for glossary file inputs.
 */
export const GLOSSARY_ACCEPT_TYPES = '.csv,.tsv,.xlf,.xliff';

/**
 * Checks if a filename has a document extension supported for translation.
 *
 * @param filename - The filename to check
 * @returns True if the file can be translated
 */
export function isDocumentTranslatableFile(filename: string): boolean {
  if (!filename) return false;

  const parts = filename.split('.');
  if (parts.length < 2) return false;

  const ext = '.' + parts.pop()?.toLowerCase();
  return DOCUMENT_TRANSLATION_EXTENSIONS.includes(ext as any);
}

/**
 * Checks whether an uploaded document is translatable by EITHER its extension OR
 * its MIME type. The extension is the primary (reliable) signal; the MIME type
 * is an additive fallback for files whose extension is missing or unusual but
 * whose type is recognized. Never rejects anything {@link isDocumentTranslatableFile}
 * accepts.
 *
 * @param filename - The uploaded file's name
 * @param mimeType - The uploaded file's MIME type (e.g. `File.type`), if any
 * @returns True if the file can be translated
 */
export function isDocumentTranslatableUpload(
  filename: string,
  mimeType?: string | null,
): boolean {
  if (isDocumentTranslatableFile(filename)) return true;
  if (!mimeType) return false;
  // Strip any `; charset=…` parameter and normalize before comparing.
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  return DOCUMENT_TRANSLATION_MIME_TYPES.includes(normalized as any);
}

/**
 * Checks if a filename has a glossary extension.
 *
 * @param filename - The filename to check
 * @returns True if the file can be used as a glossary
 */
export function isGlossaryFile(filename: string): boolean {
  if (!filename) return false;

  const parts = filename.split('.');
  if (parts.length < 2) return false;

  const ext = '.' + parts.pop()?.toLowerCase();
  return GLOSSARY_EXTENSIONS.includes(ext as any);
}
