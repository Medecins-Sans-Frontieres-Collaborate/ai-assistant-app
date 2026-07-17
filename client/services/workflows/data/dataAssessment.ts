'use client';

import { ColumnProfile, DataColumn } from '@/types/workflow';

export interface AssessDataInput {
  columns: DataColumn[];
  /** Scoped (possibly sampled) rows, WITH their __rid values. */
  rows: Record<string, unknown>[];
  /** Deterministic stats over the FULL table. */
  stats: ColumnProfile[];
  criteria: string[];
  scope: 'table' | 'filtered' | 'selection' | 'ingest';
  sampled: boolean;
  totalRowCount: number;
  modelId?: string;
  signal?: AbortSignal;
}

export interface AssessDataOutput {
  criteria: Array<{ criterionId: string; rating: number; summary: string }>;
  edits: Array<{
    criterion: string;
    kind: 'cell' | 'deleteRow';
    rid: string;
    columnId: string;
    before: string;
    after: string;
    reason: string;
    severity: 'minor' | 'major';
  }>;
  overallSummary: string;
}

/** Calls the data-quality assessment endpoint. */
export async function assessData(
  input: AssessDataInput,
): Promise<AssessDataOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/data/assess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    throw new Error(parsed?.error || `Assessment failed (${response.status})`);
  }
  return parsed.data as AssessDataOutput;
}
