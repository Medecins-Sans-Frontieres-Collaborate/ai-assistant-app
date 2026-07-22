/**
 * RFP scorecard pipeline orchestrator.
 *
 * Supports the human-review checkpoint: `stopAfter: 'generate_rubrics'` pauses
 * with status "awaiting_review"; `resumeFrom: 'score_vendors'` continues after
 * the reviewer approves/edits rubrics.
 */
import { getRfpOpenAIClient } from './client';
import { loadSpecFromFile } from './criteria';
import { ProgressEmitter } from './progress';
import * as buildScorecard from './stages/buildScorecard';
import * as extractPdfs from './stages/extractPdfs';
import * as extractResponses from './stages/extractResponses';
import * as generateRubrics from './stages/generateRubrics';
import * as scoreVendors from './stages/scoreVendors';

import { mkdirSync } from 'fs';
import { join } from 'path';

export const STAGE_ORDER = [
  'extract_pdfs',
  'extract_responses',
  'generate_rubrics',
  'score_vendors',
  'build_scorecard',
] as const;
export type StageName = (typeof STAGE_ORDER)[number];

export interface RfpPipelineParams {
  configPath: string;
  questionnaire: string; // local path or http(s) URL
  vendors: Array<{ name: string; source: string }>;
  workDir: string;
  outputPath: string;
  progressFile?: string;
  runId?: string;
  maxWorkers?: number;
  stopAfter?: StageName;
  resumeFrom?: StageName;
}

export async function runPipeline(params: RfpPipelineParams): Promise<void> {
  const {
    configPath,
    questionnaire,
    vendors,
    workDir,
    outputPath,
    progressFile,
    runId = 'unknown',
    maxWorkers = 4,
    stopAfter,
    resumeFrom,
  } = params;

  const pdfDir = join(workDir, 'input_pdfs');
  const textDir = join(workDir, 'pdf_text');
  const cacheDir = join(workDir, 'cache');
  for (const d of [pdfDir, textDir, cacheDir])
    mkdirSync(d, { recursive: true, mode: 0o700 });

  const vendorNames = vendors.map((v) => v.name);
  if (new Set(vendorNames).size !== vendorNames.length) {
    throw new Error('duplicate vendor names');
  }

  const startIdx = resumeFrom ? STAGE_ORDER.indexOf(resumeFrom) : 0;
  const stopIdx = stopAfter
    ? STAGE_ORDER.indexOf(stopAfter)
    : STAGE_ORDER.length - 1;
  const shouldRun = (stage: StageName) => {
    const idx = STAGE_ORDER.indexOf(stage);
    return startIdx <= idx && idx <= stopIdx;
  };

  const progress = new ProgressEmitter(progressFile || null, runId);
  // On resume, credit already-completed stages so the bar doesn't reset to 0%
  if (startIdx > 0)
    progress.markStagesComplete(
      STAGE_ORDER.slice(0, startIdx) as unknown as string[],
    );

  const pauseForReview = (after: StageName): void => {
    progress.finish('awaiting_review');
    console.log(`\n[run_id=${runId}] Paused after ${after} for review`);
  };

  const t0 = Date.now();
  try {
    const spec = loadSpecFromFile(configPath);
    console.log(
      `[run_id=${runId}] loaded criteria: ${Object.keys(spec.questions).length} questions, ` +
        `${spec.categories.length} categories`,
    );
    console.log(`[run_id=${runId}] vendors: ${vendorNames.join(', ')}`);
    console.log(`[run_id=${runId}] work_dir: ${workDir}`);
    if (resumeFrom)
      console.log(`[run_id=${runId}] resuming from: ${resumeFrom}`);
    if (stopAfter)
      console.log(`[run_id=${runId}] stopping after: ${stopAfter}`);

    // 1. Materialise input PDFs + extract text
    if (shouldRun('extract_pdfs')) {
      progress.stageStart('extract_pdfs', 1 + vendors.length);
      const qLocal = await extractPdfs.fetchSource(
        questionnaire,
        join(pdfDir, 'questionnaire.pdf'),
      );
      progress.tick(1);
      const vendorPdfs: Record<string, string> = {};
      let i = 2;
      for (const { name, source } of vendors) {
        vendorPdfs[name] = await extractPdfs.fetchSource(
          source,
          join(pdfDir, `${extractPdfs.safeVendorStem(name)}.pdf`),
        );
        progress.tick(i++);
      }
      await extractPdfs.run({
        questionnairePdf: qLocal,
        vendorPdfs,
        outDir: textDir,
      });
      progress.stageDone('extract_pdfs');
      if (stopIdx === 0) return pauseForReview('extract_pdfs');
    }

    const client = startIdx <= 3 && stopIdx >= 1 ? getRfpOpenAIClient() : null;

    // 2. Verbatim per-question extraction
    if (shouldRun('extract_responses')) {
      await extractResponses.run({
        client: client!,
        spec,
        textDir,
        vendors: vendorNames,
        cachePath: join(cacheDir, 'responses.json'),
        progress,
        maxWorkers,
      });
      if (stopIdx === 1) return pauseForReview('extract_responses');
    }

    // 3. Rubric generation
    if (shouldRun('generate_rubrics')) {
      await generateRubrics.run({
        client: client!,
        spec,
        responsesPath: join(cacheDir, 'responses.json'),
        cachePath: join(cacheDir, 'rubrics.json'),
        progress,
        maxWorkers,
      });
      if (stopIdx === 2) return pauseForReview('generate_rubrics');
    }

    // 4. Cross-vendor scoring
    if (shouldRun('score_vendors')) {
      await scoreVendors.run({
        client: client!,
        spec,
        vendors: vendorNames,
        responsesPath: join(cacheDir, 'responses.json'),
        rubricsPath: join(cacheDir, 'rubrics.json'),
        cachePath: join(cacheDir, 'scores.json'),
        progress,
        maxWorkers,
      });
      if (stopIdx === 3) return pauseForReview('score_vendors');
    }

    // 5. Scorecard xlsx
    if (shouldRun('build_scorecard')) {
      progress.stageStart('build_scorecard', 1);
      await buildScorecard.run({
        spec,
        vendors: vendorNames,
        responsesPath: join(cacheDir, 'responses.json'),
        rubricsPath: join(cacheDir, 'rubrics.json'),
        scoresPath: join(cacheDir, 'scores.json'),
        outputPath,
      });
      progress.tick(1, 1);
      progress.stageDone('build_scorecard');
    }

    progress.finish('succeeded');
    console.log(
      `\n[run_id=${runId}] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outputPath}`,
    );
  } catch (e) {
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[run_id=${runId}] pipeline failed:`, e);
    progress.finish('failed', err);
    throw e;
  }
}
