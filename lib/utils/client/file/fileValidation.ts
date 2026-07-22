/**
 * Client-side file validation utilities using magic byte signatures.
 * Provides robust file type validation by checking actual file content.
 */

/**
 * Magic byte signature for file type detection
 */
interface MagicSignature {
  bytes: (number | null)[]; // null means any byte at that position
  offset?: number; // byte offset to start checking (default 0)
}

interface FileTypeInfo {
  type: 'audio' | 'video';
  format: string;
  signatures: MagicSignature[];
}

/**
 * Magic byte signatures for audio/video formats (client-side subset)
 */
const FILE_SIGNATURES: FileTypeInfo[] = [
  // Audio formats
  {
    type: 'audio',
    format: 'mp3',
    signatures: [
      { bytes: [0x49, 0x44, 0x33] }, // ID3
      { bytes: [0xff, 0xfb] },
      { bytes: [0xff, 0xfa] },
      { bytes: [0xff, 0xf3] },
      { bytes: [0xff, 0xf2] },
    ],
  },
  {
    type: 'audio',
    format: 'wav',
    signatures: [{ bytes: [0x52, 0x49, 0x46, 0x46] }], // RIFF
  },
  {
    type: 'audio',
    format: 'm4a',
    signatures: [{ bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }], // ftyp
  },
  {
    type: 'audio',
    format: 'ogg',
    signatures: [{ bytes: [0x4f, 0x67, 0x67, 0x53] }], // OggS (also .oga/.opus)
  },
  {
    type: 'audio',
    format: 'flac',
    signatures: [{ bytes: [0x66, 0x4c, 0x61, 0x43] }], // fLaC
  },
  {
    type: 'audio',
    format: 'aac',
    signatures: [
      // ADTS syncwords (MPEG-4 / MPEG-2, with and without CRC)
      { bytes: [0xff, 0xf1] },
      { bytes: [0xff, 0xf9] },
      { bytes: [0xff, 0xf0] },
      { bytes: [0xff, 0xf8] },
      { bytes: [0x41, 0x44, 0x49, 0x46] }, // ADIF
    ],
  },
  {
    type: 'audio',
    format: 'webm-audio',
    signatures: [{ bytes: [0x1a, 0x45, 0xdf, 0xa3] }], // EBML
  },

  // Video formats
  {
    type: 'video',
    format: 'mp4',
    signatures: [{ bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }], // ftyp
  },
  {
    type: 'video',
    format: 'webm',
    signatures: [{ bytes: [0x1a, 0x45, 0xdf, 0xa3] }], // EBML
  },
  {
    type: 'video',
    format: 'mpeg',
    signatures: [
      { bytes: [0x00, 0x00, 0x01, 0xba] },
      { bytes: [0x00, 0x00, 0x01, 0xb3] },
    ],
  },
  {
    type: 'video',
    format: 'avi',
    signatures: [{ bytes: [0x52, 0x49, 0x46, 0x46] }], // RIFF
  },
  {
    type: 'video',
    format: 'mov',
    signatures: [
      { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
      { bytes: [0x6d, 0x6f, 0x6f, 0x76], offset: 4 },
    ],
  },
  {
    type: 'video',
    format: 'flv',
    signatures: [{ bytes: [0x46, 0x4c, 0x56] }], // "FLV"
  },
  {
    // ASF container covers both .wmv (video) and .wma (audio). This matcher
    // has no extension priority, so classify as video: for both cases the
    // right client-side action is the same — extract/transcode to mp3.
    type: 'video',
    format: 'asf',
    signatures: [{ bytes: [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11] }],
  },
];

/**
 * Result of file validation
 */
export interface ClientValidationResult {
  isValid: boolean;
  detectedFormat: string | null;
  detectedType: 'audio' | 'video' | null;
  error?: string;
}

/**
 * Checks if bytes match a signature pattern
 */
function matchesSignature(
  bytes: Uint8Array,
  signature: MagicSignature,
): boolean {
  const offset = signature.offset ?? 0;

  if (bytes.length < offset + signature.bytes.length) {
    return false;
  }

  for (let i = 0; i < signature.bytes.length; i++) {
    const expected = signature.bytes[i];
    if (expected === null) continue;
    if (bytes[offset + i] !== expected) return false;
  }

  return true;
}

/**
 * Additional check for RIFF format (WAV vs AVI)
 */
function isWavFormat(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // Check for "WAVE" at offset 8
  return (
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

/**
 * Reads the first N bytes of a file
 */
export async function readFileHeader(
  file: File,
  numBytes: number = 16,
): Promise<Uint8Array> {
  const slice = file.slice(0, numBytes);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Validates a file's magic bytes to determine its true type.
 *
 * @param file - File to validate
 * @param expectedType - Expected type ('audio', 'video', or 'any')
 * @returns Validation result with detected format
 */
export async function validateAudioVideoFile(
  file: File,
  expectedType: 'audio' | 'video' | 'any' = 'any',
): Promise<ClientValidationResult> {
  try {
    const bytes = await readFileHeader(file, 16);

    if (bytes.length < 4) {
      return {
        isValid: false,
        detectedFormat: null,
        detectedType: null,
        error: 'File too small to validate',
      };
    }

    for (const fileType of FILE_SIGNATURES) {
      for (const signature of fileType.signatures) {
        if (matchesSignature(bytes, signature)) {
          // Special handling for RIFF formats
          if (fileType.format === 'wav' && !isWavFormat(bytes)) {
            continue; // Not a WAV file, try next
          }
          if (fileType.format === 'avi' && isWavFormat(bytes)) {
            continue; // It's actually a WAV, not AVI
          }

          // Check type match
          const typeMatches =
            expectedType === 'any' || fileType.type === expectedType;

          if (!typeMatches) {
            return {
              isValid: false,
              detectedFormat: fileType.format,
              detectedType: fileType.type,
              error: `File is ${fileType.type} (${fileType.format}), expected ${expectedType}`,
            };
          }

          return {
            isValid: true,
            detectedFormat: fileType.format,
            detectedType: fileType.type,
          };
        }
      }
    }

    return {
      isValid: false,
      detectedFormat: null,
      detectedType: null,
      error: 'Unrecognized file format - not a valid audio or video file',
    };
  } catch (error) {
    return {
      isValid: false,
      detectedFormat: null,
      detectedType: null,
      error: error instanceof Error ? error.message : 'Failed to validate file',
    };
  }
}

/**
 * Quick check if a file is a video file (based on magic bytes)
 */
export async function isVideoFile(file: File): Promise<boolean> {
  const result = await validateAudioVideoFile(file, 'any');
  return result.isValid && result.detectedType === 'video';
}

/**
 * Quick check if a file is an audio file (based on magic bytes)
 */
export async function isAudioFile(file: File): Promise<boolean> {
  const result = await validateAudioVideoFile(file, 'any');
  return result.isValid && result.detectedType === 'audio';
}

/**
 * Determines if a file needs audio extraction (i.e., it's a video file)
 */
export async function needsAudioExtraction(file: File): Promise<boolean> {
  return await isVideoFile(file);
}

/**
 * Gets human-readable file type description
 */
export function getFileTypeDescription(result: ClientValidationResult): string {
  if (!result.isValid) {
    return 'Unknown format';
  }

  const format = result.detectedFormat?.toUpperCase() ?? 'Unknown';
  const type = result.detectedType === 'audio' ? 'Audio' : 'Video';

  return `${type} (${format})`;
}
