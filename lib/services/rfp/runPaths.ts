/**
 * Run-directory paths + run-id validation for the RFP scorecard pipeline.
 *
 * Run artifacts (uploaded PDFs, extracted text, caches, progress.json, the
 * scorecard xlsx) are an internal channel between the generate request and
 * the later progress/rubrics/resume/download requests — not persistent
 * output. They live in the OS temp directory so nothing is written into the
 * deployed application folder, and the OS reclaims the space. (Same pattern
 * as the grants pipeline.)
 *
 * Every route that receives a runId from the URL MUST validate it with
 * isValidRunId before touching the filesystem — the strict UUID shape makes
 * path traversal through the parameter impossible.
 */
import { tmpdir } from 'os';
import { join } from 'path';

const RUN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

export function rfpRunDir(runId: string): string {
  if (!isValidRunId(runId)) {
    throw new Error('Invalid run id');
  }
  return join(tmpdir(), 'rfp-runs', runId);
}
