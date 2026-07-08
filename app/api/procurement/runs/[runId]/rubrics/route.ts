import { NextRequest, NextResponse } from 'next/server';

import { canAccessProcurement } from '@/lib/services/rfp/access';
import { isValidRunId, rfpRunDir } from '@/lib/services/rfp/runPaths';

import { auth } from '@/auth';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

async function getWorkDir(runId: string) {
  if (!isValidRunId(runId)) {
    throw new Error('Invalid run id');
  }
  const workDir = rfpRunDir(runId);
  await readFile(join(workDir, 'metadata.json'), 'utf-8');
  return workDir;
}

/**
 * GET /api/procurement/runs/{runId}/rubrics
 *
 * Returns the generated rubrics for human review/editing.
 */
export async function GET(
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

    let workDir: string;
    try {
      workDir = await getWorkDir(runId);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const rubricsPath = join(workDir, 'cache', 'rubrics.json');
    let rubrics: Record<string, unknown>;
    try {
      rubrics = JSON.parse(await readFile(rubricsPath, 'utf-8'));
    } catch {
      return NextResponse.json(
        { error: 'Rubrics not generated yet' },
        { status: 404 },
      );
    }

    // Also read criteria config for category/criterion metadata
    const metadataRaw = await readFile(join(workDir, 'metadata.json'), 'utf-8');
    const metadata = JSON.parse(metadataRaw);

    let criteriaConfig = null;
    if (metadata.criteriaPath) {
      try {
        criteriaConfig = JSON.parse(
          await readFile(metadata.criteriaPath, 'utf-8'),
        );
      } catch {
        // criteria config may not be accessible
      }
    }

    return NextResponse.json({ rubrics, criteriaConfig });
  } catch (error) {
    console.error('Error fetching rubrics:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/procurement/runs/{runId}/rubrics
 *
 * Saves user-edited rubrics back to the cache.
 */
export async function PUT(
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

    let workDir: string;
    try {
      workDir = await getWorkDir(runId);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const body = await request.json();
    if (!body.rubrics || typeof body.rubrics !== 'object') {
      return NextResponse.json(
        { error: 'Invalid rubrics data' },
        { status: 400 },
      );
    }

    const rubricsPath = join(workDir, 'cache', 'rubrics.json');
    await writeFile(rubricsPath, JSON.stringify(body.rubrics, null, 2));

    // Clear any cached scores so they're regenerated with updated rubrics
    const scoresPath = join(workDir, 'cache', 'scores.json');
    await writeFile(scoresPath, '{}');

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving rubrics:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
