'use client';

import { useCallback } from 'react';

import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import {
  buildTable,
  collectHeaders,
  jsonToRawRows,
} from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

import Papa from 'papaparse';

export interface ImportedTable {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  sourceKind: 'csv' | 'json' | 'xlsx' | 'paste';
  sourceName: string;
}

function parseCsvText(text: string): {
  headers: string[];
  rows: Record<string, unknown>[];
} {
  const result = Papa.parse<Record<string, unknown>>(text.trim(), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });
  const fatal = result.errors.find((e) => e.type === 'Delimiter');
  if (fatal) {
    throw new Error(fatal.message);
  }
  return {
    headers: result.meta.fields ?? collectHeaders(result.data),
    rows: result.data,
  };
}

/**
 * Imports structured data into the workflow table model:
 * - CSV/TSV: papaparse in the browser
 * - JSON: JSON.parse + array normalization
 * - XLSX: server extraction (upload → /api/file/process, which converts
 *   via ssconvert) then papaparse on the returned text — no client xlsx lib
 */
export function useTableImport() {
  const importFile = useCallback(async (file: File): Promise<ImportedTable> => {
    const name = file.name;
    const lower = name.toLowerCase();

    if (lower.endsWith('.json')) {
      const rawRows = jsonToRawRows(JSON.parse(await file.text()));
      const table = buildTable(collectHeaders(rawRows), rawRows);
      return { ...table, sourceKind: 'json', sourceName: name };
    }

    if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
      const parsed = parseCsvText(await file.text());
      const table = buildTable(parsed.headers, parsed.rows);
      return { ...table, sourceKind: 'csv', sourceName: name };
    }

    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) {
        throw new Error(`No tabular text could be extracted from ${name}`);
      }
      const parsed = parseCsvText(extracted.text);
      const table = buildTable(parsed.headers, parsed.rows);
      return { ...table, sourceKind: 'xlsx', sourceName: name };
    }

    throw new Error('Unsupported file type — use CSV, TSV, JSON, or Excel');
  }, []);

  const importPasted = useCallback((text: string): ImportedTable => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Nothing to import');

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const rawRows = jsonToRawRows(JSON.parse(trimmed));
        const table = buildTable(collectHeaders(rawRows), rawRows);
        return { ...table, sourceKind: 'json', sourceName: 'Pasted JSON' };
      } catch {
        // fall through to CSV parsing
      }
    }

    const parsed = parseCsvText(trimmed);
    const table = buildTable(parsed.headers, parsed.rows);
    return { ...table, sourceKind: 'paste', sourceName: 'Pasted data' };
  }, []);

  return { importFile, importPasted };
}
