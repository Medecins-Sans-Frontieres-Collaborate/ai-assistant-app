import { NextRequest, NextResponse } from 'next/server';

import { canAccessProcurement } from '@/lib/services/rfp/access';
import { isValidRunId, rfpRunDir } from '@/lib/services/rfp/runPaths';

import { auth } from '@/auth';
import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * GET /api/procurement/runs/{runId}/progress
 *
 * Returns the current progress of a scorecard generation run.
 *
 * Response:
 * {
 *   runId: string;
 *   status: "running" | "succeeded" | "failed";
 *   overall_percent: number;  // 0-100
 *   current_stage: string;
 *   current_stage_name: string;
 *   stages: {
 *     extract_pdfs: { status: "completed" | "running" | "pending", percent: number };
 *     extract_responses: { status: "completed" | "running" | "pending", percent: number };
 *     generate_rubrics: { status: "completed" | "running" | "pending", percent: number };
 *     score_vendors: { status: "completed" | "running" | "pending", percent: number };
 *     build_scorecard: { status: "completed" | "running" | "pending", percent: number };
 *   };
 *   error?: string;
 *   downloadUrl?: string;  // Available when status === "succeeded"
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  try {
    // 1. Authenticate user
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

    // 2. Get run metadata
    const workDir = rfpRunDir(runId);
    const metadataPath = join(workDir, 'metadata.json');
    const progressPath = join(workDir, 'progress.json');
    const outputPath = join(workDir, 'scorecard.xlsx');

    // Check if run exists
    try {
      await access(metadataPath, constants.R_OK);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // 3. Read progress file (if exists)
    let progress: any = {
      runId,
      status: 'running',
      overall_percent: 0,
      current_stage: 1,
      current_stage_name: 'extract_pdfs',
      stages: {
        extract_pdfs: { status: 'pending', percent: 0 },
        extract_responses: { status: 'pending', percent: 0 },
        generate_rubrics: { status: 'pending', percent: 0 },
        score_vendors: { status: 'pending', percent: 0 },
        build_scorecard: { status: 'pending', percent: 0 },
      },
    };

    try {
      const progressData = await readFile(progressPath, 'utf-8');
      const progressJson = JSON.parse(progressData);

      const isAwaitingReview = progressJson.status === 'awaiting_review';

      // Map the progress.json format from the Python pipeline
      progress = {
        runId,
        status: isAwaitingReview
          ? 'awaiting_review'
          : progressJson.status || 'running',
        overall_percent: progressJson.overall_percent || 0,
        current_stage: progressJson.stage || 1,
        current_stage_name: progressJson.stage_name || 'extract_pdfs',
        stages: {
          extract_pdfs: {
            status:
              progressJson.stage >= 2
                ? 'completed'
                : progressJson.stage === 1
                  ? 'running'
                  : 'pending',
            percent:
              progressJson.stage >= 2
                ? 100
                : progressJson.stage === 1
                  ? progressJson.stage_percent || 0
                  : 0,
          },
          extract_responses: {
            status:
              progressJson.stage >= 3
                ? 'completed'
                : progressJson.stage === 2
                  ? 'running'
                  : 'pending',
            percent:
              progressJson.stage >= 3
                ? 100
                : progressJson.stage === 2
                  ? progressJson.stage_percent || 0
                  : 0,
          },
          generate_rubrics: {
            status:
              isAwaitingReview && progressJson.stage === 3
                ? 'completed'
                : progressJson.stage >= 4
                  ? 'completed'
                  : progressJson.stage === 3
                    ? 'running'
                    : 'pending',
            percent:
              isAwaitingReview && progressJson.stage === 3
                ? 100
                : progressJson.stage >= 4
                  ? 100
                  : progressJson.stage === 3
                    ? progressJson.stage_percent || 0
                    : 0,
          },
          score_vendors: {
            status:
              progressJson.stage >= 5
                ? 'completed'
                : progressJson.stage === 4
                  ? 'running'
                  : 'pending',
            percent:
              progressJson.stage >= 5
                ? 100
                : progressJson.stage === 4
                  ? progressJson.stage_percent || 0
                  : 0,
          },
          build_scorecard: {
            status:
              progressJson.stage === 5
                ? progressJson.status === 'succeeded'
                  ? 'completed'
                  : 'running'
                : 'pending',
            percent:
              progressJson.stage === 5
                ? progressJson.status === 'succeeded'
                  ? 100
                  : progressJson.stage_percent || 0
                : 0,
          },
        },
        error: progressJson.error,
      };
    } catch (err) {
      // Progress file doesn't exist yet or is malformed
      console.log(`[${runId}] Progress file not available yet`);
    }

    // 4. Check if output file exists (completed)
    try {
      await access(outputPath, constants.R_OK);
      progress.status = 'succeeded';
      progress.overall_percent = 100;
      progress.downloadUrl = `/api/procurement/runs/${runId}/download`;
    } catch {
      // Output not ready yet
    }

    return NextResponse.json(progress);
  } catch (error) {
    console.error('Error fetching progress:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
