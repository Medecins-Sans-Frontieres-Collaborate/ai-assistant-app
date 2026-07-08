import { NextRequest, NextResponse } from 'next/server';

import { canAccessProcurement } from '@/lib/services/rfp/access';
import { parseCriteriaGrid } from '@/lib/services/rfp/parseCriteriaGrid';
import { runPipeline } from '@/lib/services/rfp/pipeline';
import { rfpRunDir } from '@/lib/services/rfp/runPaths';
import { extractPdfText } from '@/lib/services/rfp/stages/extractPdfs';

import { auth } from '@/auth';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/procurement/generate-scorecard
 *
 * Triggers RFP scorecard generation from questionnaire + vendor response PDFs.
 * The pipeline runs in-process (TypeScript, no subprocess) and pauses after
 * rubric generation for human review.
 *
 * Request: multipart/form-data with:
 *   - questionnaire: File (PDF)
 *   - criteriaGrid: File (PDF, Excel, etc.)
 *   - rfpName: string (e.g., "coffee_vendor")
 *   - vendor_N_file / vendor_N_name pairs (as many vendors as needed)
 *
 * Response: { runId, status: "running", progressUrl }
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate user
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessProcurement(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 2. Parse multipart form data
    const formData = await request.formData();
    const questionnaireFile = formData.get('questionnaire') as File | null;
    const criteriaGridFile = formData.get('criteriaGrid') as File | null;
    const rfpName = (formData.get('rfpName') as string) || 'custom_rfp';

    const vendorFiles: Array<{ name: string; file: File }> = [];
    let vendorIndex = 0;
    while (formData.has(`vendor_${vendorIndex}_file`)) {
      const file = formData.get(`vendor_${vendorIndex}_file`) as File;
      const name = formData.get(`vendor_${vendorIndex}_name`) as string;
      vendorFiles.push({ name, file });
      vendorIndex++;
    }

    if (
      !questionnaireFile ||
      !criteriaGridFile ||
      !rfpName ||
      vendorFiles.length === 0
    ) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: questionnaire, criteria grid, RFP name, and at least one vendor file',
        },
        { status: 400 },
      );
    }

    // 3. Generate run ID and create directories
    const runId = uuidv4();
    const workDir = rfpRunDir(runId);
    const uploadsDir = join(workDir, 'uploads');
    await mkdir(uploadsDir, { recursive: true, mode: 0o700 });

    console.log(`[${runId}] Saving uploaded files...`);

    // 4. Save questionnaire + criteria grid
    const questionnairePath = join(uploadsDir, 'questionnaire.pdf');
    await writeFile(
      questionnairePath,
      Buffer.from(await questionnaireFile.arrayBuffer()),
    );
    console.log(`[${runId}] Saved questionnaire: ${questionnaireFile.name}`);

    const gridExt =
      (criteriaGridFile.name.split('.').pop() || 'pdf')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 8) || 'pdf';
    const criteriaGridPath = join(uploadsDir, `criteria_grid.${gridExt}`);
    await writeFile(
      criteriaGridPath,
      Buffer.from(await criteriaGridFile.arrayBuffer()),
    );
    console.log(`[${runId}] Saved criteria grid: ${criteriaGridFile.name}`);

    // 5. Extract text (pdftotext) and parse the criteria grid with AI.
    // The grid is tabular, so extract it in layout mode — reading-order mode
    // dissociates criterion names from their weight column.
    console.log(
      `[${runId}] Extracting text from questionnaire and criteria grid...`,
    );
    const questionnaireText = await extractPdfText(questionnairePath);
    const criteriaGridText = await extractPdfText(criteriaGridPath, true);

    console.log(`[${runId}] Parsing criteria grid with AI...`);
    const criteriaConfig = await parseCriteriaGrid(
      criteriaGridText,
      questionnaireText,
      rfpName,
    );
    console.log(
      `[${runId}] Generated criteria config with ${Object.keys(criteriaConfig.questions || {}).length} questions and ${(criteriaConfig.categories || []).length} categories`,
    );

    // 6. Save criteria config inside the run's work dir
    const criteriaPath = join(workDir, 'criteria.json');
    await writeFile(criteriaPath, JSON.stringify(criteriaConfig, null, 2));

    // 7. Save vendor files
    const vendorPaths: Record<string, string> = {};
    for (let i = 0; i < vendorFiles.length; i++) {
      const { name, file } = vendorFiles[i];
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
      const vendorPath = join(uploadsDir, `vendor_${i}_${safeName}`);
      await writeFile(vendorPath, Buffer.from(await file.arrayBuffer()));
      vendorPaths[name] = vendorPath;
      console.log(`[${runId}] Saved vendor ${name}: ${file.name}`);
    }

    const outputPath = join(workDir, 'scorecard.xlsx');
    const progressPath = join(workDir, 'progress.json');

    // 8. Store run metadata (includes paths needed to resume the pipeline)
    const metadata = {
      runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      questionnaireFile: questionnaireFile.name,
      vendorFiles: vendorFiles.map((v) => ({
        name: v.name,
        filename: v.file.name,
      })),
      workDir,
      outputPath,
      progressPath,
      uploadsDir,
      criteriaPath,
      questionnairePath,
      vendorPaths,
      userId: session.user.id || session.user.mail || 'unknown',
    };
    await writeFile(
      join(workDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
    );

    // 9. Launch the pipeline in-process (fire-and-forget); pauses after
    //    rubric generation for the human review step.
    console.log(`[${runId}] Starting pipeline (stop after generate_rubrics)`);
    runPipeline({
      configPath: criteriaPath,
      questionnaire: questionnairePath,
      vendors: Object.entries(vendorPaths).map(([name, source]) => ({
        name,
        source,
      })),
      workDir,
      outputPath,
      progressFile: progressPath,
      runId,
      maxWorkers: 4,
      stopAfter: 'generate_rubrics',
    }).catch((err) => {
      console.error(`[${runId}] Pipeline failed:`, err);
    });

    // 10. Return response
    return NextResponse.json({
      runId,
      status: 'running',
      progressUrl: `/api/procurement/runs/${runId}/progress`,
      estimatedCompletionMinutes: 5,
    });
  } catch (error) {
    console.error('Error starting scorecard generation:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
