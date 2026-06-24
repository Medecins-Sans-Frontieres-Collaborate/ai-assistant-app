import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';
import { runPipeline } from '@/lib/services/grants/pipeline';
import { grantRunDir } from '@/lib/services/grants/runPaths';

import { BlobProperty } from '@/lib/utils/server/blob/blob';

import { auth } from '@/auth';
import { mkdir, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { v4 as uuidv4 } from 'uuid';

interface ExtractRequestBody {
  oc: string;
  documentBlobPaths: string[];
  supplementalBlobPaths?: Record<string, string>;
  selectedColumns?: string[];
  year?: number;
  /** Source-filename → project-code, confirmed in the pre-processing coverage check. */
  codeOverrides?: Record<string, string>;
}

/**
 * POST /api/grants/extract
 *
 * Starts a grant extraction pipeline run. Downloads documents from blob storage,
 * then runs the TypeScript pipeline in the background.
 *
 * Request JSON:
 * {
 *   oc: string;                                    // Operating company identifier
 *   documentBlobPaths: string[];                    // Blob paths to grant documents
 *   supplementalBlobPaths?: Record<string, string>; // Optional supplemental files (name -> blob path)
 *   selectedColumns?: string[];
 *   year?: number;
 * }
 *
 * Response:
 * {
 *   runId: string;
 *   status: "running";
 *   progressUrl: string;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate user
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 2. Parse request body
    const body: ExtractRequestBody = await request.json();
    const {
      oc,
      documentBlobPaths,
      supplementalBlobPaths,
      selectedColumns,
      year,
      codeOverrides,
    } = body;

    if (!oc || !documentBlobPaths || documentBlobPaths.length === 0) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: oc and documentBlobPaths (non-empty array)',
        },
        { status: 400 },
      );
    }

    // 3. Generate run ID and create work directories
    const runId = uuidv4();
    const workDir = grantRunDir(runId);
    const documentsDir = join(workDir, 'documents');
    const supplementalDir = join(workDir, 'supplemental');
    await mkdir(documentsDir, { recursive: true });
    await mkdir(supplementalDir, { recursive: true });

    console.log(`[${runId}] Starting grant extraction for OC: ${oc}`);

    // 4. Download documents from blob storage to work directory
    const blobClient = createBlobStorageClient(session);
    const downloadedDocPaths: string[] = [];

    for (const blobPath of documentBlobPaths) {
      const fileName = basename(blobPath);
      const localPath = join(documentsDir, fileName);

      console.log(`[${runId}] Downloading document: ${blobPath}`);
      const buffer = (await blobClient.get(
        blobPath,
        BlobProperty.BLOB,
      )) as Buffer;
      await writeFile(localPath, buffer);
      downloadedDocPaths.push(localPath);
      console.log(
        `[${runId}] Saved document: ${fileName} (${buffer.length} bytes)`,
      );
    }

    // 5. Download supplemental files from blob storage
    if (
      supplementalBlobPaths &&
      Object.keys(supplementalBlobPaths).length > 0
    ) {
      for (const [name, blobPath] of Object.entries(supplementalBlobPaths)) {
        const fileName = basename(blobPath);
        const localPath = join(supplementalDir, fileName);

        console.log(
          `[${runId}] Downloading supplemental file: ${name} -> ${blobPath}`,
        );
        const buffer = (await blobClient.get(
          blobPath,
          BlobProperty.BLOB,
        )) as Buffer;
        await writeFile(localPath, buffer);
        console.log(
          `[${runId}] Saved supplemental: ${fileName} (${buffer.length} bytes)`,
        );
      }
    }

    // 6. Build pipeline parameters
    const outputPath = join(workDir, 'output.csv');
    const validationOutputPath = join(workDir, 'validation.json');
    const progressPath = join(workDir, 'progress.json');

    // 7. Write metadata.json to work directory
    const metadata = {
      runId,
      oc,
      status: 'running',
      startedAt: new Date().toISOString(),
      documentBlobPaths,
      supplementalBlobPaths: supplementalBlobPaths || {},
      selectedColumns: selectedColumns || [],
      year: year || new Date().getFullYear(),
      codeOverrides: codeOverrides || {},
      downloadedDocPaths,
      workDir,
      outputPath,
      validationOutputPath,
      progressPath,
      userId: session.user.id || 'unknown',
    };

    await writeFile(
      join(workDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
    );

    // 8. Run pipeline in background (don't await — return immediately)
    runPipeline({
      oc,
      documents: downloadedDocPaths,
      supplementalDir,
      workDir,
      outputPath,
      validationOutputPath,
      progressFile: progressPath,
      runId,
      maxWorkers: 3,
      year: year || new Date().getFullYear(),
      codeOverrides: codeOverrides || {},
    }).catch((err) => {
      console.error(`[${runId}] Pipeline failed:`, err);
    });

    // 9. Return response
    return NextResponse.json({
      runId,
      status: 'running',
      progressUrl: `/api/grants/runs/${runId}/progress`,
    });
  } catch (error) {
    console.error('Error starting grant extraction:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
