import { NextRequest, NextResponse } from 'next/server';

import { canAccessGrants } from '@/lib/services/grants/access';
import { revalidateRows } from '@/lib/services/grants/revalidate';
import { grantRunDir } from '@/lib/services/grants/runPaths';

import { auth } from '@/auth';
import { constants } from 'fs';
import { access, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Convert an array of row objects back to CSV format.
 * Handles quoting for fields that contain commas, quotes, or newlines.
 */
function rowsToCSV(columns: string[], rows: Record<string, string>[]): string {
  function escapeField(value: string): string {
    if (
      value.includes(',') ||
      value.includes('"') ||
      value.includes('\n') ||
      value.includes('\r')
    ) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  const headerLine = columns.map(escapeField).join(',');

  const dataLines = rows.map((row) =>
    columns.map((col) => escapeField(row[col] || '')).join(','),
  );

  return [headerLine, ...dataLines].join('\n');
}

interface SaveRequestBody {
  rows: Record<string, string>[];
}

/**
 * POST /api/grants/runs/{runId}/save
 *
 * Saves inline edits made to the extraction output.
 * Overwrites output.csv with the updated rows, then re-runs validation.
 *
 * Request JSON:
 * {
 *   rows: Record<string, string>[];  // Updated row data
 * }
 *
 * Response:
 * {
 *   success: boolean;
 *   rowCount: number;
 *   validation: object;
 * }
 */
export async function POST(
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
    const outputPath = join(workDir, 'output.csv');
    const validationPath = join(workDir, 'validation.json');

    try {
      await access(metadataPath, constants.R_OK);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // 3. Parse request body
    const body: SaveRequestBody = await request.json();
    const { rows } = body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: 'Missing or empty rows array in request body' },
        { status: 400 },
      );
    }

    // 4. Determine columns from existing output or from the rows themselves
    let columns: string[];

    try {
      await access(outputPath, constants.R_OK);
      const existingCSV = await readFile(outputPath, 'utf-8');
      const firstLine = existingCSV.split('\n')[0];

      // Parse header line to extract column names
      columns = [];
      let field = '';
      let inQuotes = false;

      for (let i = 0; i < firstLine.length; i++) {
        const char = firstLine[i];
        if (char === '"') {
          if (
            inQuotes &&
            i + 1 < firstLine.length &&
            firstLine[i + 1] === '"'
          ) {
            field += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          columns.push(field.trim());
          field = '';
        } else {
          field += char;
        }
      }
      columns.push(field.trim());
    } catch {
      // No existing CSV - derive columns from the first row
      columns = Object.keys(rows[0]);
    }

    // 5. Write updated CSV to work directory (overwrite output.csv)
    const csvContent = rowsToCSV(columns, rows);
    await writeFile(outputPath, csvContent, 'utf-8');

    console.log(`[${runId}] Saved ${rows.length} rows to output.csv`);

    // 6. Re-run validation on edited rows
    let validation: object = {};
    const cacheDir = join(workDir, 'cache');

    try {
      // Read metadata to get OC
      const metadataText = await readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataText);
      const oc = metadata.oc;

      console.log(`[${runId}] Re-running validation for OC=${oc}...`);

      const result = revalidateRows({
        oc,
        cacheDir,
        validationOutput: validationPath,
        rows,
      });

      if (result) {
        validation = result;
      }

      console.log(`[${runId}] Revalidation complete`);
    } catch (revalError) {
      console.error(
        `[${runId}] Revalidation failed, falling back to stale validation:`,
        revalError,
      );
      // Fallback: read existing validation.json if available
      try {
        await access(validationPath, constants.R_OK);
        const validationText = await readFile(validationPath, 'utf-8');
        validation = JSON.parse(validationText);
      } catch {
        // No validation available
      }
    }

    // 7. Return success response
    return NextResponse.json({
      success: true,
      rowCount: rows.length,
      validation,
    });
  } catch (error) {
    console.error('Error saving grant extraction edits:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
