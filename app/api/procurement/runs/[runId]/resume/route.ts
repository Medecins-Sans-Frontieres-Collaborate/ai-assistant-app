import { NextRequest, NextResponse } from 'next/server';

import { canAccessProcurement } from '@/lib/services/rfp/access';
import { runPipeline } from '@/lib/services/rfp/pipeline';
import { isValidRunId, rfpRunDir } from '@/lib/services/rfp/runPaths';

import { auth } from '@/auth';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * POST /api/procurement/runs/{runId}/resume
 *
 * Resumes the pipeline from the scoring stage after rubric review.
 * Runs in-process (TypeScript) — cached extraction and reviewed rubrics are
 * reused; only scoring and the scorecard build execute.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessProcurement(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { runId } = await params;
    if (!isValidRunId(runId)) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const workDir = rfpRunDir(runId);
    const metadataPath = join(workDir, 'metadata.json');

    let metadata: Record<string, any>;
    try {
      metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    console.log(`[${runId}] Resuming pipeline from score_vendors`);
    runPipeline({
      configPath: metadata.criteriaPath,
      questionnaire: metadata.questionnairePath,
      vendors: Object.entries(
        metadata.vendorPaths as Record<string, string>,
      ).map(([name, source]) => ({ name, source })),
      workDir: metadata.workDir,
      outputPath: metadata.outputPath,
      progressFile: metadata.progressPath,
      runId,
      maxWorkers: 4,
      resumeFrom: 'score_vendors',
    }).catch((err) => {
      console.error(`[${runId}] Resumed pipeline failed:`, err);
    });

    return NextResponse.json({
      runId,
      status: 'running',
      progressUrl: `/api/procurement/runs/${runId}/progress`,
    });
  } catch (error) {
    console.error('Error resuming pipeline:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
