/**
 * Entry points the file-import handlers call: is this a zip (reject with
 * guidance), and if it parses as JSON, is it a ChatGPT or Claude export?
 */
import { isChatGptExport, parseChatGptExport } from './chatgpt';
import { isClaudeExport, parseClaudeExport } from './claude';
import { ForeignImportDetection } from './types';

/**
 * Recognise a third-party export by structure. Returns null for anything
 * else (including the app's own export formats, which callers check first).
 */
export const detectForeignExport = (
  data: unknown,
): ForeignImportDetection | null => {
  if (isChatGptExport(data)) {
    return { source: 'chatgpt', ...parseChatGptExport(data) };
  }
  if (isClaudeExport(data)) {
    return { source: 'claude', ...parseClaudeExport(data) };
  }
  return null;
};

/**
 * Both ChatGPT and Claude deliver exports as a zip archive. The app does not
 * unpack archives (see lib/constants/disallowedFileTypes.ts); the user is
 * asked to extract `conversations.json` instead. Sniffs the local-file
 * header ("PK\x03\x04") so a renamed archive is still caught.
 */
export const isZipArchive = async (file: File): Promise<boolean> => {
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip') || file.type === 'application/zip') return true;
  if (file.size < 4) return false;
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return (
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      head[2] === 0x03 &&
      head[3] === 0x04
    );
  } catch {
    return false;
  }
};
