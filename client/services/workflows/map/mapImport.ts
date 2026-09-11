'use client';

/**
 * Getting a file or pasted text ready for the import dialog, and landing the
 * confirmed result on a map.
 *
 * Structured location data never goes near the model: a GeoJSON with five
 * hundred stated coordinates used to be flattened to prose so the model could
 * re-guess each position — slow, lossy, and billed. Now the only server
 * round-trip is the one Excel already needed (the workbook is converted to
 * CSV text), and everything else parses in the browser.
 */
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';

import {
  NamedConnection,
  resolveConnections,
} from '@/lib/utils/shared/geo/connections';
import {
  ImportBuildResult,
  ImportedFeature,
} from '@/lib/utils/shared/geo/importBuild';
import {
  DetectedMapping,
  detectMapping,
} from '@/lib/utils/shared/geo/importFields';
import {
  ImportFormat,
  ParsedImport,
  parseImport,
  sniffImportFormat,
} from '@/lib/utils/shared/geo/importParse';
import { kmlFromKmz } from '@/lib/utils/shared/geo/kmz';

import { MapConnection, MapFeature, MapSourceRecord } from '@/types/workflow';

import { v4 as uuidv4 } from 'uuid';

/** Everything the dialog needs to show a file before anything is committed. */
export interface PreparedImport {
  sourceName: string;
  format: ImportFormat;
  parsed: ParsedImport;
  detected: DetectedMapping;
}

/** Largest text we will parse in the browser. Well past any real location file. */
export const MAX_IMPORT_TEXT_CHARS = 30 * 1024 * 1024;

function prepare(
  sourceName: string,
  format: ImportFormat,
  text: string,
): PreparedImport {
  const parsed = parseImport(format, text);
  return {
    sourceName,
    format,
    parsed,
    detected: detectMapping(parsed.headers),
  };
}

/**
 * Reads a file into a prepared import, or returns null when the file is not
 * location data — prose, or JSON that is not GeoJSON or rows — so the caller
 * can send it to the model as it always has.
 */
export async function prepareImportFromFile(
  file: File,
): Promise<PreparedImport | null> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.kmz')) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return prepare(file.name, 'kml', kmlFromKmz(bytes));
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    // The workbook comes back as CSV text; from here it is a spreadsheet.
    const extracted = await uploadAndExtractText(file);
    if (!extracted.text.trim()) return null;
    const format = sniffImportFormat(`${file.name}.csv`, extracted.text);
    return format ? prepare(file.name, format, extracted.text) : null;
  }
  // Binary documents (PDF, Word…) are never location data.
  if (/\.(pdf|docx?|pptx?)$/.test(lower)) return null;
  const text = await file.text();
  if (text.length > MAX_IMPORT_TEXT_CHARS) return null;
  const format = sniffImportFormat(file.name, text);
  return format ? prepare(file.name, format, text) : null;
}

/** Same for pasted text; `sourceName` labels the source record. */
export function prepareImportFromText(
  text: string,
  sourceName: string,
): PreparedImport | null {
  const format = sniffImportFormat(undefined, text);
  return format ? prepare(sourceName, format, text) : null;
}

/** What the dialog hands back once the person confirms. */
export interface ConfirmedImport {
  sourceName: string;
  format: ImportFormat;
  features: ImportedFeature[];
  connections: NamedConnection[];
  stats: ImportBuildResult['stats'];
  /** Ask the model to fill in category/description/country afterwards. */
  enrich: boolean;
}

export interface MaterializedImport {
  sourceId: string;
  features: MapFeature[];
  connections: MapConnection[];
  record: MapSourceRecord;
  /** Name-referenced connections that matched nothing on the map. */
  unresolvedConnections: number;
}

/**
 * Gives confirmed rows workspace identities: fresh ids, one source record of
 * kind 'import', and connections resolved by name against this import first
 * and the existing map second. Pure with respect to storage — the workspace
 * and the dataset editor each write it to their own state.
 */
export function materializeImport(
  confirmed: ConfirmedImport,
  existingFeatures: readonly MapFeature[],
): MaterializedImport {
  const sourceId = uuidv4();
  const features: MapFeature[] = confirmed.features.map(
    ({ rowIndex: _row, ...feature }) => ({
      ...feature,
      id: uuidv4(),
      sourceId,
    }),
  );
  const { connections, unresolved } = resolveConnections(
    confirmed.connections,
    [...features, ...existingFeatures],
    uuidv4,
    sourceId,
  );
  return {
    sourceId,
    features,
    connections,
    unresolvedConnections: unresolved,
    record: {
      id: sourceId,
      name: confirmed.sourceName,
      addedAt: new Date().toISOString(),
      featureCount: features.length,
      kind: 'import',
    },
  };
}
