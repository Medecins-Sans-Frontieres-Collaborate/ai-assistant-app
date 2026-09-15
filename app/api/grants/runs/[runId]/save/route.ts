import { NextRequest, NextResponse } from 'next/server';

import { revalidateRows } from '@/lib/services/grants/revalidate';
import {
  readOwnedRunMetadata,
  readRunFileIfExists,
} from '@/lib/services/grants/runFiles';
import { grantRunDir, isValidRunId } from '@/lib/services/grants/runPaths';
import { canUseGrants } from '@/lib/services/grants/serverAccess';

import { auth } from '@/auth';
import { writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Bounds on an edit payload. The rows are written to local disk as-is, so
 * without a cap a single authorized caller could fill the temp volume of the
 * replica. Real extractions are tens to hundreds of rows; both limits are an
 * order of magnitude above anything the pipeline produces.
 */
export const MAX_SAVE_ROWS = 10_000;
export const MAX_SAVE_BODY_BYTES = 20 * 1024 * 1024;

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
    if (!(await canUseGrants(session.user))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { runId } = await params;
    if (!isValidRunId(runId)) {
      return NextResponse.json({ error: 'Invalid runId' }, { status: 400 });
    }

    // 2. Verify the run exists AND belongs to the caller (foreign → 404)
    const workDir = grantRunDir(runId);
    const outputPath = join(workDir, 'output.csv');
    const validationPath = join(workDir, 'validation.json');

    const owned = await readOwnedRunMetadata(workDir, session.user.id);
    if (!owned.ok) {
      return NextResponse.json(
        { error: owned.error },
        { status: owned.status },
      );
    }
    const metadata = owned.metadata;

    // 3. Parse request body (bounded — it lands on local disk verbatim)
    const rawBody = await request.text();
    if (rawBody.length > MAX_SAVE_BODY_BYTES) {
      return NextResponse.json(
        { error: 'Request body too large' },
        { status: 413 },
      );
    }
    let body: SaveRequestBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const rows = body?.rows;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: 'Missing or empty rows array in request body' },
        { status: 400 },
      );
    }
    if (rows.length > MAX_SAVE_ROWS) {
      return NextResponse.json(
        { error: `Too many rows (max ${MAX_SAVE_ROWS})` },
        { status: 413 },
      );
    }
    if (
      !rows.every(
        (row) => row && typeof row === 'object' && !Array.isArray(row),
      )
    ) {
      return NextResponse.json(
        { error: 'Every row must be an object' },
        { status: 400 },
      );
    }

    // 4. Determine columns from existing output or from the rows themselves
    let columns: string[];

    const existingCSV = await readRunFileIfExists(outputPath);
    if (existingCSV !== null) {
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
    } else {
      // No existing CSV - derive columns from the first row
      columns = Object.keys(rows[0]);
    }

    // 5. Write updated CSV to work directory (overwrite output.csv)
    const csvContent = rowsToCSV(columns, rows);
    await writeFile(outputPath, csvContent, { encoding: 'utf-8', mode: 0o600 });

    console.log(`[${runId}] Saved ${rows.length} rows to output.csv`);

    // 6. Re-run validation on edited rows
    let validation: object = {};
    const cacheDir = join(workDir, 'cache');

    try {
      const oc = metadata.oc;
      if (typeof oc !== 'string' || !oc) {
        throw new Error('Run metadata has no OC');
      }

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
        const validationText = await readRunFileIfExists(validationPath);
        if (validationText !== null) validation = JSON.parse(validationText);
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
