/**
 * Per-run file access for the grants run routes (data / download / save /
 * progress). Two rules every route shares:
 *
 * 1. NO check-then-read. Existence is learned from the read itself (ENOENT
 *    → "not there"), never from a preceding `access()`: the pair is a
 *    time-of-check/time-of-use race by shape (CodeQL js/file-system-race),
 *    and the check buys nothing the read's own error does not already say.
 * 2. OWNERSHIP. The grants entitlement is broad (a directory attribute plus
 *    the admin workflow toggle), but a run belongs to the user who started
 *    it. Run ids are random UUIDs, so this only matters once a run URL has
 *    been shared — and then a foreign run must read as NOT FOUND rather than
 *    forbidden, so the id's mere existence is never confirmed either.
 */
import { readFile, stat } from 'fs/promises';
import { join } from 'path';

/** The subset of metadata.json (written by /api/grants/extract) routes rely on. */
export interface GrantRunMetadata {
  runId?: string;
  oc?: string;
  userId?: string;
  documentBlobPaths?: string[];
  [key: string]: unknown;
}

export type OwnedRunResult =
  | { ok: true; metadata: GrantRunMetadata }
  | { ok: false; status: 404; error: 'Run not found' };

const NOT_FOUND: OwnedRunResult = {
  ok: false,
  status: 404,
  error: 'Run not found',
};

/**
 * Reads the run's text file, or null when it does not exist yet. Any other
 * failure (permissions, a directory where a file was expected) propagates —
 * those are bugs, not "not ready".
 */
export async function readRunFileIfExists(
  path: string,
  encoding: BufferEncoding = 'utf-8',
): Promise<string | null> {
  try {
    return await readFile(path, encoding);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether a run artifact exists. Existence only — never followed by a read. */
export async function runFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Loads `<workDir>/metadata.json` and checks the caller owns the run. A
 * missing, unreadable, unparseable, ownerless, or foreign run all resolve to
 * the same "not found" so the caller can return one uniform 404.
 */
export async function readOwnedRunMetadata(
  workDir: string,
  userId: string | undefined,
): Promise<OwnedRunResult> {
  if (!userId) return NOT_FOUND;
  let text: string | null;
  try {
    text = await readRunFileIfExists(join(workDir, 'metadata.json'));
  } catch {
    return NOT_FOUND;
  }
  if (text === null) return NOT_FOUND;
  let metadata: GrantRunMetadata;
  try {
    metadata = JSON.parse(text) as GrantRunMetadata;
  } catch {
    return NOT_FOUND;
  }
  if (!metadata || typeof metadata !== 'object') return NOT_FOUND;
  // `/api/grants/extract` records 'unknown' for a session without an id;
  // such a run has no owner and is claimable by nobody.
  if (
    typeof metadata.userId !== 'string' ||
    metadata.userId === 'unknown' ||
    metadata.userId !== userId
  ) {
    return NOT_FOUND;
  }
  return { ok: true, metadata };
}
