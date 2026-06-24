import { NextRequest, NextResponse } from 'next/server';

import { canAccessGrants } from '@/lib/services/grants/access';
import { grantRunDir } from '@/lib/services/grants/runPaths';

import { auth } from '@/auth';
import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Parse a CSV string into an array of row objects.
 * Handles quoted fields containing commas and newlines.
 */
function parseCSV(csvText: string): {
  columns: string[];
  rows: Record<string, string>[];
} {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  // Split into lines, respecting quoted fields that may contain newlines
  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];

    if (char === '"') {
      // Check for escaped quote ("") — preserve both for parseLine to handle
      if (inQuotes && i + 1 < csvText.length && csvText[i + 1] === '"') {
        current += '""';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
    } else if (char === '\n' && !inQuotes) {
      if (current.trim()) {
        lines.push(current);
      }
      current = '';
    } else if (char === '\r' && !inQuotes) {
      // Skip carriage returns
    } else {
      current += char;
    }
  }

  // Push last line
  if (current.trim()) {
    lines.push(current);
  }

  if (lines.length === 0) {
    return { columns: [], rows: [] };
  }

  // Parse a single CSV line into fields
  function parseLine(line: string): string[] {
    const fields: string[] = [];
    let field = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (insideQuotes && i + 1 < line.length && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        fields.push(field.trim());
        field = '';
      } else {
        field += char;
      }
    }

    fields.push(field.trim());
    return fields;
  }

  // First line is the header
  const columns = parseLine(lines[0]);

  // Remaining lines are data rows
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseLine(lines[i]);
    const row: Record<string, string> = {};

    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = fields[j] || '';
    }

    rows.push(row);
  }

  return { columns, rows };
}

/**
 * GET /api/grants/runs/{runId}/data
 *
 * Returns the extraction output as structured JSON for inline editing.
 * Reads output.csv and validation.json from the work directory.
 *
 * Response:
 * {
 *   columns: string[];
 *   rows: Record<string, string>[];
 *   validation: object;
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
    const outputPath = join(workDir, 'output.csv');
    const validationPath = join(workDir, 'validation.json');

    try {
      await access(metadataPath, constants.R_OK);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // 3. Read and parse output CSV
    let columns: string[] = [];
    let rows: Record<string, string>[] = [];

    try {
      await access(outputPath, constants.R_OK);
      const csvText = await readFile(outputPath, 'utf-8');
      const parsed = parseCSV(csvText);
      columns = parsed.columns;
      rows = parsed.rows;
    } catch {
      return NextResponse.json(
        { error: 'Output CSV not ready yet' },
        { status: 404 },
      );
    }

    // 4. Read validation JSON (optional - may not exist yet)
    let validation: object = {};

    try {
      await access(validationPath, constants.R_OK);
      const validationText = await readFile(validationPath, 'utf-8');
      validation = JSON.parse(validationText);
    } catch {
      // Validation file not available - return empty object
      console.log(`[${runId}] Validation file not available`);
    }

    // 5. Read supplemental report (optional)
    let supplementalReport: object | null = null;
    const supplementalReportPath = join(
      workDir,
      'cache',
      'supplemental_report.json',
    );

    try {
      await access(supplementalReportPath, constants.R_OK);
      const reportText = await readFile(supplementalReportPath, 'utf-8');
      supplementalReport = JSON.parse(reportText);
    } catch {
      // Supplemental report not available
    }

    // 6. Build source-file-to-blob-path mapping from metadata
    //    Source File values use .txt extensions (extracted text stage),
    //    while blob paths use the original .pdf/.docx extension.
    //    Match by filename stem.
    let sourceFileMap: Record<string, string> = {};

    try {
      const metadataText = await readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataText);
      const blobPaths: string[] = metadata.documentBlobPaths || [];

      for (const blobPath of blobPaths) {
        const blobFilename = blobPath.split('/').pop() || '';
        const stem = blobFilename.replace(/\.[^.]+$/, '');
        // Map both the .txt version and original filename.
        // Also map with spaces replaced by underscores (and vice-versa)
        // because the extraction stage normalizes spaces to underscores
        // in Source File values, while blob paths retain original names.
        const variants = [
          stem,
          stem.replace(/ /g, '_'),
          stem.replace(/_/g, ' '),
        ];
        const uniqueVariants = [...new Set(variants)];
        for (const v of uniqueVariants) {
          sourceFileMap[v + '.txt'] = blobPath;
          sourceFileMap[v + '.pdf'] = blobPath;
          sourceFileMap[v + '.docx'] = blobPath;
        }
        sourceFileMap[blobFilename] = blobPath;
      }
    } catch {
      // Metadata not available — sourceFileMap stays empty
    }

    // 7. Return structured data
    return NextResponse.json({
      columns,
      rows,
      validation,
      sourceFileMap,
      ...(supplementalReport ? { supplementalReport } : {}),
    });
  } catch (error) {
    console.error('Error fetching grant extraction data:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
