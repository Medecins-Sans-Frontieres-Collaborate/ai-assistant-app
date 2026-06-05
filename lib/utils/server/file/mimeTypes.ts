/**
 * MIME type utilities for file handling
 * Centralized MIME type mappings to prevent duplication
 */

// Re-export file validation utilities for convenience
export {
  validateFileSignature,
  validateBufferSignature,
  readFileHeader,
  validateFile,
  isValidAudioFile,
  isValidVideoFile,
  isValidAudioVideoFile,
  FILE_SIGNATURES,
  type SignatureValidationResult,
  type FileTypeSignature,
  type MagicSignature,
} from './fileValidation';

/**
 * Comprehensive MIME type mapping for common file extensions
 */
export const MIME_TYPE_MAP: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',

  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Text
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'text/xml',
  csv: 'text/csv',

  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/m4a',
  mpga: 'audio/mpeg',

  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mpeg: 'video/mpeg',
};

/**
 * List of executable file extensions that should be blocked for security
 */
export const EXECUTABLE_EXTENSIONS = [
  'exe',
  'bat',
  'cmd',
  'sh',
  'dll',
  'msi',
  'jar',
  'app',
  'com',
  'scr',
  'vbs',
  'ps1',
];

/**
 * List of executable MIME types that should be blocked for security
 */
export const EXECUTABLE_MIME_TYPES = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-sharedlib',
  'application/java-archive',
  'application/x-apple-diskimage',
  'application/x-sh',
  'application/x-bat',
];

/**
 * Gets the MIME type for a given filename or extension
 *
 * @param filename - The filename or extension
 * @returns The MIME type string, or 'application/octet-stream' if unknown
 *
 * @example
 * getContentType('document.pdf') // 'application/pdf'
 * getContentType('pdf') // 'application/pdf'
 * getContentType('unknown.xyz') // 'application/octet-stream'
 */
export function getContentType(filename: string): string {
  const extension = filename.includes('.')
    ? filename.split('.').pop()?.toLowerCase().trim()
    : filename.toLowerCase().trim();

  if (!extension) {
    return 'application/octet-stream';
  }

  return MIME_TYPE_MAP[extension] || 'application/octet-stream';
}

/**
 * Checks if a filename has an executable extension
 *
 * @param filename - The filename to check
 * @returns True if the file has an executable extension
 */
export function isExecutableFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension ? EXECUTABLE_EXTENSIONS.includes(extension) : false;
}

/**
 * Checks if a MIME type is for an executable file
 *
 * @param mimeType - The MIME type to check
 * @returns True if the MIME type is for an executable
 */
export function isExecutableMimeType(mimeType: string): boolean {
  return EXECUTABLE_MIME_TYPES.includes(mimeType);
}

/**
 * Validates that a file is not an executable
 *
 * @param filename - The filename to check
 * @param mimeType - Optional MIME type to check
 * @returns Object with isValid boolean and error message if invalid
 */
export function validateFileNotExecutable(
  filename: string,
  mimeType?: string | null,
): { isValid: boolean; error?: string } {
  if (isExecutableFile(filename)) {
    return {
      isValid: false,
      error: 'Executable files are not allowed',
    };
  }

  if (mimeType && isExecutableMimeType(mimeType)) {
    return {
      isValid: false,
      error: 'Invalid file type submitted',
    };
  }

  return { isValid: true };
}
