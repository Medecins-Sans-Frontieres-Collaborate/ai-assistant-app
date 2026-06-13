import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Cheap shape check: base64 alphabet, optional padding, length % 4 === 0. */
const BASE64_SHAPE_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Heuristic: is this string a base64 payload (vs. a file path)?
 *
 * The cheap shape check rejects file paths immediately — extensions ('.'),
 * underscores, and hyphens are not base64 characters — without paying for a
 * decode of a potentially multi-megabyte string. Strings that pass the shape
 * check still get the strict decode/re-encode round trip, preserving the
 * original semantics (only canonical base64 of valid UTF-8 qualifies).
 */
export function isBase64(str: string): boolean {
  if (!str || str.length % 4 !== 0 || !BASE64_SHAPE_REGEX.test(str)) {
    return false;
  }
  try {
    return (
      Buffer.from(Buffer.from(str, 'base64').toString('utf8')).toString(
        'base64',
      ) === str
    );
  } catch {
    return false;
  }
}

export async function saveBase64AsFile(base64String: string): Promise<string> {
  // randomUUID (not a timestamp) — concurrent chunk transcriptions must not
  // collide on the same temp filename within one millisecond.
  const tempFilePath = path.join(os.tmpdir(), `temp_audio_${randomUUID()}.wav`);
  const buffer = Buffer.from(base64String, 'base64');
  // Write file with secure permissions (0o600 = read/write for owner only)
  await fs.promises.writeFile(tempFilePath, new Uint8Array(buffer), {
    mode: 0o600,
  });
  console.log(`[Transcription] Saved base64 input to: ${tempFilePath}`);
  return tempFilePath;
}

export async function cleanUpFiles(filePaths: string[]): Promise<void> {
  await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
        console.log(`Deleted file: ${sanitizeForLog(filePath)}`);
      } catch {
        console.log(`File not found: ${sanitizeForLog(filePath)}`);
      }
    }),
  );
}
