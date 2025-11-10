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
