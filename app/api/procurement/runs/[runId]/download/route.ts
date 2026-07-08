import { NextRequest, NextResponse } from 'next/server';

import { canAccessProcurement } from '@/lib/services/rfp/access';
import { isValidRunId, rfpRunDir } from '@/lib/services/rfp/runPaths';

import { auth } from '@/auth';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * GET /api/procurement/runs/{runId}/download
 *
 * Downloads the completed scorecard XLSX file.
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

    // 2. Get output file path
    const workDir = rfpRunDir(runId);
    const outputPath = join(workDir, 'scorecard.xlsx');
    const metadataPath = join(workDir, 'metadata.json');

    // Check if run exists
    try {
      await readFile(metadataPath, 'utf-8');
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // 3. Read the file (no pre-check: read directly and map ENOENT to 404)
    let fileBuffer: Buffer;
    try {
      fileBuffer = await readFile(outputPath);
    } catch {
      return NextResponse.json(
        { error: 'Scorecard not ready yet' },
        { status: 404 },
      );
    }

    // 4. Return file as download
    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="RFP_Scorecard_${runId.slice(0, 8)}.xlsx"`,
        'Content-Length': fileBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error('Error downloading scorecard:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
