import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Base directory for a grant pipeline run's transient artifacts (downloaded
 * documents, extracted text, progress.json, output.csv, validation.json, etc.).
 *
 * These files are an internal channel between the extraction request and the
 * later progress/data/download/save requests — they are NOT persistent output.
 * We keep them in the OS temp directory rather than the app/repo working
 * directory so nothing is written into the deployed application folder (or the
 * git tree), and the OS reclaims the space.
 */
export function grantRunDir(runId: string): string {
  return join(tmpdir(), 'grant-runs', runId);
}
