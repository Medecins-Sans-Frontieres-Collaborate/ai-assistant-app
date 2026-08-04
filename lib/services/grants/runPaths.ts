import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve, sep } from 'path';

/**
 * Per-run artifacts (downloaded docs, extracted text, progress.json,
 * output.csv) live under the OS temp dir so nothing is written into the
 * deployed app folder and the OS reclaims the space.
 */

const RUN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRunId(runId: string): boolean {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

export function assertValidRunId(runId: string): string {
  if (!isValidRunId(runId)) throw new Error('Invalid grant run id');
  return runId;
}

function ensurePrivateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function grantRunsBase(): string {
  return ensurePrivateDir(join(tmpdir(), 'grant-runs'));
}

function grantPreprocessBase(): string {
  return ensurePrivateDir(join(tmpdir(), 'grant-preprocess'));
}

export function safeChildName(name: string): string {
  return basename(name).replace(/\.\.+/g, '.');
}

export function safeJoin(base: string, segment: string): string {
  const joined = resolve(base, segment);
  if (segment.includes('..') || !joined.startsWith(resolve(base) + sep)) {
    throw new Error('Unsafe path segment');
  }
  return joined;
}

export function grantRunDir(runId: string): string {
  return safeJoin(grantRunsBase(), assertValidRunId(runId));
}

export function grantPreprocessDir(runId: string): string {
  return safeJoin(grantPreprocessBase(), assertValidRunId(runId));
}

/** Coverage-check progress file (written by POST, polled by GET). */
export function preprocessProgressPath(runId: string): string {
  return safeJoin(
    grantPreprocessBase(),
    `progress-${assertValidRunId(runId)}.json`,
  );
}
