/**
 * Shared location of the coverage-check progress file (written by the
 * preprocess POST handler, read by the progress GET handler). Keyed by runId
 * and kept in the OS temp dir.
 */
import { tmpdir } from 'os';
import { join } from 'path';

export function preprocessProgressPath(runId: string): string {
  return join(tmpdir(), `grant-preprocess-progress-${runId}.json`);
}
