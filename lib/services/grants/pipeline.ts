/**
 * Main pipeline orchestrator.
 */
import { Session } from 'next-auth';

import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { loadOCConfig } from './ocConfig';
import { ProgressEmitter } from './progress';
import * as enrich from './stages/enrich';
import * as exportStage from './stages/export';
import * as extractFields from './stages/extractFields';
import * as extractText from './stages/extractText';
import * as normalize from './stages/normalize';
import * as validate from './stages/validate';

import { mkdirSync } from 'fs';
import { join } from 'path';

export interface PipelineParams {
  oc: string;
  documents: string[];
  supplementalDir?: string;
  workDir: string;
  outputPath: string;
  validationOutputPath?: string;
  progressFile?: string;
  runId?: string;
  maxWorkers?: number;
  year?: number;
  /** Source-filename → project-code, confirmed in the pre-processing coverage check. */
  codeOverrides?: Record<string, string>;
  /** Per-OC prompt override (saved or in-flight) to use instead of the default. */
  promptOverride?: string;
  /**
   * The user the run belongs to. Present, its model calls are recorded to
   * telemetry and debited against the shared token pool — grants is
   * telemetry-only, with no impact badge
   * (docs/WORKFLOW_EMISSIONS_DESIGN.md §7a).
   */
  user?: Session['user'];
}

export async function runPipeline(params: PipelineParams): Promise<void> {
  const {
    oc,
    documents,
    supplementalDir,
    workDir,
    outputPath,
    validationOutputPath,
    progressFile,
    runId = 'unknown',
    maxWorkers = 3,
    year = new Date().getFullYear(),
    codeOverrides,
    promptOverride,
    user,
  } = params;

  // Telemetry + quota sink for the whole run. Absent a user the pipeline
  // still runs — it just records nothing, rather than failing.
  const usage = user
    ? new WorkflowUsageCollector({
        user,
        action: 'grants:extract',
        conversationId: runId,
      })
    : undefined;

  // Create work sub-directories
  const textDir = join(workDir, 'extracted_text');
  const fieldsDir = join(workDir, 'extracted_fields');
  const cacheDir = join(workDir, 'cache');
  for (const d of [textDir, fieldsDir, cacheDir]) {
    mkdirSync(d, { recursive: true });
  }

  // Load OC-specific configuration
  const ocCfg = loadOCConfig(oc);

  // Initialise progress emitter
  const progress = new ProgressEmitter(progressFile || null, runId);
  const t0 = Date.now();

  console.log(
    `[run_id=${runId}] oc=${oc}, year=${year}, documents=${documents.length}`,
  );
  console.log(`[run_id=${runId}] work_dir: ${workDir}`);

  try {
    // ----------------------------------------------------------------
    // Stage 1: extract_text
    // ----------------------------------------------------------------
    await extractText.run({
      documents,
      outDir: textDir,
      progress,
      cacheDir: join(cacheDir, 'text_cache'),
    });

    // ----------------------------------------------------------------
    // Stage 2: extract_fields
    // ----------------------------------------------------------------
    await extractFields.run({
      ocCfg,
      textDir,
      outDir: fieldsDir,
      progress,
      maxWorkers,
      year,
      promptOverride,
      usage,
    });

    // ----------------------------------------------------------------
    // Stage 3: normalize
    // ----------------------------------------------------------------
    await normalize.run({
      ocCfg,
      fieldsDir,
      cacheDir,
      progress,
      year,
      textDir,
      codeOverrides,
    });

    // ----------------------------------------------------------------
    // Stage 4: enrich
    // ----------------------------------------------------------------
    await enrich.run({
      ocCfg,
      cacheDir,
      supplementalDir,
      progress,
      maxWorkers,
      year,
    });

    // ----------------------------------------------------------------
    // Stage 5: validate
    // ----------------------------------------------------------------
    validate.run({
      ocCfg,
      cacheDir,
      validationOutput: validationOutputPath,
      progress,
      textDir,
      year,
    });

    // ----------------------------------------------------------------
    // Stage 6: build_output (export)
    // ----------------------------------------------------------------
    exportStage.run({
      ocCfg,
      cacheDir,
      outputPath,
      progress,
    });

    progress.finish('succeeded');
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[run_id=${runId}] DONE in ${dt}s -> ${outputPath}`);
  } catch (e) {
    const err =
      e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    console.error(`[run_id=${runId}] Pipeline failed:`, e);
    progress.finish('failed', err);
    throw e;
  }
}
