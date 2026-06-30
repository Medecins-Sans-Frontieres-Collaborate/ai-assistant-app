import { NextRequest, NextResponse } from 'next/server';

import { canAccessGrants } from '@/lib/services/grants/access';
import { grantRunDir } from '@/lib/services/grants/runPaths';

import { auth } from '@/auth';
import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Stage definitions for the grant extraction pipeline.
 * Each stage maps to a step in the Python grant_extractor process.
 */
const STAGES = [
  { key: 'extract_text', label: 'Extract Text', stageNum: 1 },
  { key: 'extract_fields', label: 'Extract Fields', stageNum: 2 },
  { key: 'normalize', label: 'Normalize Data', stageNum: 3 },
  { key: 'enrich', label: 'Enrich Records', stageNum: 4 },
  { key: 'validate', label: 'Validate Output', stageNum: 5 },
  { key: 'build_output', label: 'Build Output', stageNum: 6 },
] as const;

type StageKey = (typeof STAGES)[number]['key'];
type StageStatus = 'completed' | 'running' | 'pending' | 'failed';

interface StageProgress {
  status: StageStatus;
  percent: number;
  label: string;
}

interface ProgressResponse {
  runId: string;
  status: 'running' | 'succeeded' | 'failed';
  overall_percent: number;
  current_stage: number;
  current_stage_name: string;
  stages: Record<StageKey, StageProgress>;
  error?: string;
  downloadUrl?: string;
}

/**
 * GET /api/grants/runs/{runId}/progress
 *
 * Returns the current progress of a grant extraction run.
 * Reads progress.json written by the Python pipeline subprocess.
 *
 * Response:
 * {
 *   runId: string;
 *   status: "running" | "succeeded" | "failed";
 *   overall_percent: number;
 *   current_stage: number;
 *   current_stage_name: string;
 *   stages: {
 *     extract_text: { status, percent, label };
 *     extract_fields: { status, percent, label };
 *     normalize: { status, percent, label };
 *     enrich: { status, percent, label };
 *     validate: { status, percent, label };
 *     build_output: { status, percent, label };
 *   };
 *   error?: string;
 *   downloadUrl?: string;
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
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { runId } = await params;

    // 2. Verify run exists
    const workDir = grantRunDir(runId);
    const metadataPath = join(workDir, 'metadata.json');
    const progressPath = join(workDir, 'progress.json');
    const outputPath = join(workDir, 'output.csv');

    try {
      await access(metadataPath, constants.R_OK);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // 3. Build default progress response
    const defaultStages = {} as Record<StageKey, StageProgress>;
    for (const stage of STAGES) {
      defaultStages[stage.key] = {
        status: 'pending',
        percent: 0,
        label: stage.label,
      };
    }

    let progress: ProgressResponse = {
      runId,
      status: 'running',
      overall_percent: 0,
      current_stage: 1,
      current_stage_name: 'extract_text',
      stages: defaultStages,
    };

    // 4. Read progress file if it exists
    try {
      const progressData = await readFile(progressPath, 'utf-8');
      const progressJson = JSON.parse(progressData);

      // Map the Python pipeline's progress.json format to the response structure
      const currentStageNum: number = progressJson.stage || 1;
      const currentStageName: string =
        progressJson.stage_name || 'extract_text';
      const stagePercent: number = progressJson.stage_percent || 0;

      const stages = {} as Record<StageKey, StageProgress>;
      for (const stage of STAGES) {
        let status: StageStatus;
        let percent: number;

        if (
          progressJson.status === 'failed' &&
          stage.stageNum === currentStageNum
        ) {
          status = 'failed';
          percent = stagePercent;
        } else if (stage.stageNum < currentStageNum) {
          status = 'completed';
          percent = 100;
        } else if (stage.stageNum === currentStageNum) {
          status = 'running';
          percent = stagePercent;
        } else {
          status = 'pending';
          percent = 0;
        }

        stages[stage.key] = {
          status,
          percent,
          label: stage.label,
        };
      }

      progress = {
        runId,
        status: progressJson.status || 'running',
        overall_percent: progressJson.overall_percent || 0,
        current_stage: currentStageNum,
        current_stage_name: currentStageName,
        stages,
        error: progressJson.error,
      };
    } catch {
      // Progress file doesn't exist yet or is malformed - use defaults
      console.log(`[${runId}] Progress file not available yet`);
    }

    // 5. Check if output file exists (indicates completion)
    try {
      await access(outputPath, constants.R_OK);
      if (progress.status !== 'failed') {
        progress.status = 'succeeded';
        progress.overall_percent = 100;
        progress.downloadUrl = `/api/grants/runs/${runId}/download?file=output`;

        // Mark all stages as completed
        for (const stage of STAGES) {
          progress.stages[stage.key].status = 'completed';
          progress.stages[stage.key].percent = 100;
        }
      }
    } catch {
      // Output not ready yet
    }

    return NextResponse.json(progress);
  } catch (error) {
    console.error('Error fetching grant extraction progress:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
