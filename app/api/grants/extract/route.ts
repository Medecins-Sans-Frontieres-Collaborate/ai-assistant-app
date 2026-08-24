import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';
import { resolveOC } from '@/lib/services/grants/ocConfig';
import { runPipeline } from '@/lib/services/grants/pipeline';
import { loadPromptOverride } from '@/lib/services/grants/promptStore';
import {
  grantRunDir,
  safeChildName,
  safeJoin,
} from '@/lib/services/grants/runPaths';

import { BlobProperty } from '@/lib/utils/server/blob/blob';

import { auth } from '@/auth';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

interface ExtractRequestBody {
  oc: string;
  documentBlobPaths: string[];
  supplementalBlobPaths?: Record<string, string>;
  selectedColumns?: string[];
  year?: number;
  codeOverrides?: Record<string, string>;
  promptOverride?: string;
}

/**
 * POST /api/grants/extract
 *
 * Starts a grant extraction pipeline run. Downloads documents from blob storage,
 * then runs the TypeScript pipeline in the background.
 *
 * Request JSON:
 * {
 *   oc: string;                                     //OC identifier
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
      documentBlobPaths,
      supplementalBlobPaths,
      selectedColumns,
      year,
      codeOverrides,
      promptOverride,
    } = body;

    // Resolve the client-supplied OC name against the static allowlist; the
    // canonical value (never the request string) is used everywhere below.
    const oc = resolveOC(body.oc);
    if (!oc || !documentBlobPaths || documentBlobPaths.length === 0) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: oc (known oc) and documentBlobPaths (non-empty array)',
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
      const fileName = safeChildName(blobPath);
      const localPath = safeJoin(documentsDir, fileName);

      console.log(
        `[${runId}] Downloading document: ${JSON.stringify(blobPath)}`,
      );
      const buffer = (await blobClient.get(
        blobPath,
        BlobProperty.BLOB,
      )) as Buffer;
      await writeFile(localPath, buffer, { mode: 0o600 });
      downloadedDocPaths.push(localPath);
      console.log(
        `[${runId}] Saved document: ${JSON.stringify(fileName)} (${buffer.length} bytes)`,
      );
    }

    // 5. Download supplemental files from blob storage
    if (
      supplementalBlobPaths &&
      Object.keys(supplementalBlobPaths).length > 0
    ) {
      for (const [name, blobPath] of Object.entries(supplementalBlobPaths)) {
        const fileName = safeChildName(blobPath);
        const localPath = safeJoin(supplementalDir, fileName);

        console.log(
          `[${runId}] Downloading supplemental file: ${JSON.stringify(name)} -> ${JSON.stringify(blobPath)}`,
        );
        const buffer = (await blobClient.get(
          blobPath,
          BlobProperty.BLOB,
        )) as Buffer;
        await writeFile(localPath, buffer, { mode: 0o600 });
        console.log(
          `[${runId}] Saved supplemental: ${JSON.stringify(fileName)} (${buffer.length} bytes)`,
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
      { mode: 0o600 },
    );

    // Resolve the prompt: unsaved in-flight edits (body) take precedence, then a
    // saved per-OC override, else the pipeline builds the code default.
    let resolvedPromptOverride: string | undefined = promptOverride?.trim()
      ? promptOverride
      : undefined;
    if (!resolvedPromptOverride) {
      const saved = await loadPromptOverride(blobClient, oc);
      if (saved) resolvedPromptOverride = saved.prompt;
    }

    // 8. Run pipeline in background
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
      year: Number(year) || new Date().getFullYear(),
      codeOverrides: codeOverrides || {},
      promptOverride: resolvedPromptOverride,
    }).catch((err) => {
      console.error(
        `[${runId}] Pipeline failed:`,
        JSON.stringify(err instanceof Error ? err.message : String(err)),
      );
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
