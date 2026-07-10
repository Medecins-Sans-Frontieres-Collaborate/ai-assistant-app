'use client';

import {
  DocumentProfile,
  DocumentSpec,
  ReviewCriterionRating,
} from '@/types/workflow';

export interface AssessDocumentInput {
  /** Always the FULL document markdown. */
  docMarkdown: string;
  /** Scope the assessment to this excerpt (substring of docMarkdown). */
  selection?: string;
  /** [] = profile-only run. */
  criteria: string[];
  customCriteria?: Array<{ id: string; name: string; rubric: string }>;
  spec?: DocumentSpec;
  tone?: { name: string; voiceRules: string; examples?: string };
  profile?: DocumentProfile;
  modelId?: string;
  signal?: AbortSignal;
}

export interface AssessDocumentOutput {
  profile: DocumentProfile;
  criteria: ReviewCriterionRating[];
  overallSummary: string;
  edits: Array<{
    criterion: string;
    before: string;
    after: string;
    reason: string;
    severity: 'minor' | 'major';
  }>;
}

/** Calls the document assessment/profile endpoint. */
export async function assessDocument(
  input: AssessDocumentInput,
): Promise<AssessDocumentOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/document/assess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    throw new Error(parsed?.error || `Assessment failed (${response.status})`);
  }
  return parsed.data as AssessDocumentOutput;
}
