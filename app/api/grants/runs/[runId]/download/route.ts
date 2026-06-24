import { NextRequest, NextResponse } from 'next/server';

import { canAccessGrants } from '@/lib/services/grants/access';
import { grantRunDir } from '@/lib/services/grants/runPaths';

import { auth } from '@/auth';
import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Parse a single CSV line into an array of field values,
 * respecting quoted fields that may contain commas or newlines.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Quote a CSV field if it contains commas, quotes, or newlines.
 */
function quoteCSVField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

/**
 * Split CSV content into logical rows, respecting quoted fields
 * that may contain embedded newlines.
 */
function splitCSVRows(content: string): string[] {
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          current += '""';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
          current += ch;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        current += ch;
      } else if (ch === '\n') {
        // Handle \r\n
        if (current.endsWith('\r')) {
          current = current.slice(0, -1);
        }
        rows.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  // Push last row if non-empty
  if (current.trim() !== '') {
    rows.push(current);
  }
  return rows;
}

/**
 * Filter a CSV buffer to include only the specified columns.
 * Returns a new Buffer with only the selected columns.
 */
function filterCSVColumns(
  csvBuffer: Buffer,
  selectedColumns: string[],
): Buffer {
  const content = csvBuffer.toString('utf-8');
  const rows = splitCSVRows(content);
  if (rows.length === 0) return csvBuffer;

  // Parse header row to find column indices
  const headerFields = parseCSVLine(rows[0]);
  const selectedSet = new Set(selectedColumns);
  const keepIndices = headerFields
    .map((h, i) => (selectedSet.has(h.trim()) ? i : -1))
    .filter((i) => i !== -1);

  // If no columns matched or all columns selected, return original
  if (keepIndices.length === 0 || keepIndices.length === headerFields.length) {
    return csvBuffer;
  }

  // Rebuild CSV with only selected columns
  const filteredLines: string[] = [];
  for (const row of rows) {
    if (row.trim() === '') continue;
    const fields = parseCSVLine(row);
    const filtered = keepIndices.map((i) => quoteCSVField(fields[i] ?? ''));
    filteredLines.push(filtered.join(','));
  }

  return Buffer.from(filteredLines.join('\n') + '\n', 'utf-8');
}

/**
 * GET /api/grants/runs/{runId}/download?file=output|validation&columns=col1,col2,...
 *
 * Downloads the results of a completed grant extraction run.
 *
 * Query params:
 *   file: "output" (CSV) or "validation" (JSON)
 *   columns: comma-separated list of column names to include (output CSV only)
 *
 * Response:
 *   - output: text/csv file download of output.csv (filtered if columns specified)
 *   - validation: application/json file download of validation.json
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

    // 2. Determine which file to serve
    const { searchParams } = new URL(request.url);
    const fileType = searchParams.get('file') || 'output';

    if (fileType !== 'output' && fileType !== 'validation') {
      return NextResponse.json(
        { error: 'Invalid file parameter. Must be "output" or "validation".' },
        { status: 400 },
      );
    }

    // 3. Resolve file paths
    const workDir = grantRunDir(runId);
    const metadataPath = join(workDir, 'metadata.json');

    // Check if run exists
    try {
      await access(metadataPath, constants.R_OK);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // 4. Determine target file based on query param
    let filePath: string;
    let contentType: string;
    let downloadFileName: string;

    if (fileType === 'output') {
      filePath = join(workDir, 'output.csv');
      contentType = 'text/csv';
      downloadFileName = `Grant_Extraction_${runId.slice(0, 8)}.csv`;
    } else {
      filePath = join(workDir, 'validation.json');
      contentType = 'application/json';
      downloadFileName = `Grant_Validation_${runId.slice(0, 8)}.json`;
    }

    // 5. Check if file exists
    try {
      await access(filePath, constants.R_OK);
    } catch {
      return NextResponse.json(
        {
          error: `${fileType === 'output' ? 'Output CSV' : 'Validation report'} not ready yet`,
        },
        { status: 404 },
      );
    }

    // 6. Read and serve the file
    const fileBuffer = await readFile(filePath);

    // 7. Apply column filtering for CSV downloads if columns param is present
    const columnsParam = searchParams.get('columns');
    let outputBytes: Uint8Array = new Uint8Array(fileBuffer);
    if (fileType === 'output' && columnsParam) {
      const selectedColumns = columnsParam.split(',').map(decodeURIComponent);
      outputBytes = new Uint8Array(
        filterCSVColumns(fileBuffer, selectedColumns),
      );
    }

    return new NextResponse(
      outputBytes as unknown as ConstructorParameters<typeof NextResponse>[0],
      {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${downloadFileName}"`,
          'Content-Length': outputBytes.length.toString(),
        },
      },
    );
  } catch (error) {
    console.error('Error downloading grant extraction results:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
