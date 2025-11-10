import { sanitizeForLog } from '@/lib/utils/server/logSanitization';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const unlinkAsync = promisify(fs.unlink);

export function isBase64(str: string): boolean {
  console.time('isBase64');
  try {
    const result =
      Buffer.from(Buffer.from(str, 'base64').toString('utf8')).toString(
        'base64',
      ) === str;
    console.timeEnd('isBase64');
    return result;
  } catch (err) {
    console.timeEnd('isBase64');
    return false;
  }
}

export async function saveBase64AsFile(base64String: string): Promise<string> {
  console.time('saveBase64AsFile');
  console.log('Saving base64 string as file...');
  const tempFilePath = path.join(os.tmpdir(), `temp_audio_${Date.now()}.wav`);
  const buffer = Buffer.from(base64String, 'base64');
  // Write file with secure permissions (0o600 = read/write for owner only)
  await fs.promises.writeFile(tempFilePath, new Uint8Array(buffer), {
    mode: 0o600,
  });
  console.log(`File saved at: ${tempFilePath}`);
  console.timeEnd('saveBase64AsFile');
  return tempFilePath;
}

export function cleanUpFiles(filePaths: string[]): Promise<void[]> {
  console.time('cleanUpFiles');
  console.log(`Cleaning up ${filePaths.length} files...`);
  const unlinkPromises = filePaths.map(async (filePath) => {
    await fs.promises
      .access(filePath)
      .then(() => unlinkAsync(filePath))
      .then(() => console.log(`Deleted file: ${sanitizeForLog(filePath)}`))
      .catch(() => console.log(`File not found: ${sanitizeForLog(filePath)}`));
  });
  console.timeEnd('cleanUpFiles');
  return Promise.all(unlinkPromises);
}
