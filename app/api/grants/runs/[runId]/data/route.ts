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
 * Classify a source document as a regular project narrative vs a non-narrative
 * document (coordination, strategy, or overview). Non-narrative documents often
 * list projects that also have their own dedicated narrative, so the UI flags
 * them for the user to review before including them in the final CSV.
 * Content-based (reads the extracted-text header) with a filename fallback.
 */
function classifyDocType(
  headerText: string,
  filename: string,
): 'coordination' | 'strategy' | 'narrative' {
  const t = (headerText || '').slice(0, 4000).toLowerCase();
  const f = (filename || '').toLowerCase();
  const inText = (arr: string[]) => arr.some((k) => t.includes(k));
  const inName = (arr: string[]) => arr.some((k) => f.includes(k));

  if (
    inText([
      'strategy paper',
      'strategic plan',
      'plan stratégique',
      'document de stratégie',
      'stratégie pays',
      'mission strategy',
    ]) ||
    inName(['strategy', 'strateg', 'plan_strat'])
  ) {
    return 'strategy';
  }
  if (
    inText([
      'coordination nationale',
      'national coordination',
      'analyse de la mission',
      'mission coordination',
      'coordination cell',
      'coordo cell',
      'annual operational plan – coordination',
    ]) ||
    inName(['coordination', 'coordo', 'mission_analysis'])
  ) {
    return 'coordination';
  }
  return 'narrative';
}

/**
 * An explicit document-type signal in the filename (e.g. "..._Coordination_Final.docx").
 * This is a deliberate label the author put in the filename, so it takes priority
 * over the model's content-based guess — the model sometimes reads a coordination
 * document that describes a project and calls it a "project narrative".
 */
function filenameStrongType(filename: string): string | null {
  const f = (filename || '').toLowerCase();
  if (/coordination|coordo\b/.test(f)) return 'coordination';
  if (/strateg/.test(f)) return 'strategy';
  return null;
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
          // The extraction stage's safeStem replaces EVERY non-alphanumeric
          // character (spaces, "&", accents, parentheses, dots) with "_" when
          // naming the .txt file, so build that same canonical key — otherwise
          // documents with special characters in their filename (e.g. "CEH
          // régional", "Port-à-Piment", "BD112&BD114") get no source-document link.
          stem.replace(/[^a-zA-Z0-9_-]/g, '_'),
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

    // 6b. Determine each source document's type (narrative vs coordination /
    //     strategy / overview / compilation) so the UI can flag non-narrative
    //     sources for the user to review before including them in the final CSV.
    //     Prefer the MODEL's classification (document_types.json, written by
    //     normalize from the extraction call); fall back to deterministic keyword
    //     classification for any source not covered (e.g. older runs). Will
    //     likely revise this more with the Grants team.
    const textDir = join(workDir, 'extracted_text');
    const sourceTypes: Record<string, string> = {};
    let modelTypes: Record<string, string> = {};
    try {
      const dtText = await readFile(
        join(workDir, 'cache', 'document_types.json'),
        'utf-8',
      );
      modelTypes = JSON.parse(dtText);
    } catch {
      // No model classification available — keyword fallback below.
    }
    const uniqueSources = [
      ...new Set(rows.map((r) => r['Source File']).filter(Boolean)),
    ];
    await Promise.all(
      uniqueSources.map(async (sf) => {
        // 1. An explicit label in the filename wins over everything.
        const strong = filenameStrongType(sf);
        if (strong) {
          sourceTypes[sf] = strong;
          return;
        }
        // 2. The model's content-based classification (from the extraction call).
        if (modelTypes[sf] && modelTypes[sf].trim()) {
          sourceTypes[sf] = modelTypes[sf].trim();
          return;
        }
        // 3. Keyword classification of the extracted text (older runs).
        let header = '';
        try {
          header = await readFile(join(textDir, sf), 'utf-8');
        } catch {
          // Extracted text unavailable (e.g. cleaned up) — fall back to filename.
        }
        sourceTypes[sf] = classifyDocType(header, sf);
      }),
    );

    // 7. Return structured data
    return NextResponse.json({
      columns,
      rows,
      validation,
      sourceFileMap,
      sourceTypes,
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
