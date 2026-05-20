/**
 * Shared file type constants used across the application.
 * Centralized to ensure consistency and easy maintenance.
 */

/**
 * Audio and video file extensions supported for transcription.
 * These files are processed by Whisper API.
 */
export const AUDIO_VIDEO_EXTENSIONS = [
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
  // Additional video formats (audio extracted via FFmpeg)
  '.mkv',
  '.mov',
  '.avi',
  '.flv',
  '.wmv',
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
  'audio/*,video/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm,.mkv,.mov,.avi,.flv,.wmv';

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
 * Accept attribute value for file inputs that accept documents for translation.
 */
export const DOCUMENT_TRANSLATION_ACCEPT_TYPES =
  '.txt,.html,.htm,.docx,.xlsx,.pptx,.msg,.xlf,.xliff,.csv,.tsv,.tab,.mhtml,.mht';

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
