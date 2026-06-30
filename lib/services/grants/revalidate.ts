// Re-validate edited rows after user saves changes.
import { loadOCConfig } from './ocConfig';
import { NoopProgress } from './progress';
import * as validate from './stages/validate';
import type { ValidationResult } from './stages/validate';

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export interface RevalidateParams {
  oc: string;
  cacheDir: string;
  validationOutput?: string;
  rows: AnyRecord[];
}

export function revalidateRows(
  params: RevalidateParams,
): ValidationResult | undefined {
  const { oc, cacheDir, validationOutput, rows } = params;

  const ocCfg = loadOCConfig(oc);
  const progress = new NoopProgress();

  // Write rows as enriched_records.json so validate.run() can read them
  const enrichedPath = join(cacheDir, 'enriched_records.json');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(enrichedPath, JSON.stringify(rows, null, 2), 'utf-8');

  // Run validation
  const result = validate.run({
    ocCfg,
    cacheDir,
    validationOutput,
    progress,
  });

  if (result) {
    console.log(
      `[revalidate] Done: ${result.summary.errors} errors, ` +
        `${result.summary.warnings} warnings`,
    );
  }

  return result;
}
