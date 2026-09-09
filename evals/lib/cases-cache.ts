/**
 * Disk cache for run results keyed by (case content, model, strategy).
 * Goal-model references are the expensive, stable part of a parity run, so
 * re-running with a new aspirational strategy only pays for the candidate.
 * Set EVAL_NO_CACHE=1 to bypass.
 */
import type { EvalCase, RunResult } from './types';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'evals/results/.cache');

export function runCacheKey(
  evalCase: EvalCase,
  modelId: string,
  strategyId: string,
  strategyVersion: string,
): string {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ evalCase, modelId, strategyId, strategyVersion }));
  return h.digest('hex').slice(0, 24);
}

export function readCachedRun(key: string): RunResult | null {
  if (process.env.EVAL_NO_CACHE) return null;
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunResult;
  } catch {
    return null;
  }
}

export function writeCachedRun(key: string, result: RunResult): void {
  if (result.error) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CACHE_DIR, `${key}.json`),
    JSON.stringify(result, null, 2),
  );
}
