'use client';

import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';

import { CustomCriterionDefinition } from '@/lib/utils/shared/review/customCriteria';

import {
  GlossaryEntry,
  TranslationCriterionRating,
  TranslationEdit,
} from '@/types/workflow';

export interface AssessTranslationInput {
  sourceText: string;
  translation: string;
  targetLanguage: string;
  /** Built-in ids and/or 'custom:<uuid>' ids. */
  criteria: string[];
  /**
   * Definitions for every custom id in `criteria`. The server is stateless
   * and never reads the user's settings, so the rubrics ride the request.
   */
  customCriteria?: CustomCriterionDefinition[];
  glossaryEntries?: GlossaryEntry[];
  /** Admin terminology guide; entries resolve server-side and merge in. */
  glossaryGuideId?: string;
  modelId?: string;
  /** Attributes the run's token spend to this conversation's ledger. */
  conversationId?: string;
  signal?: AbortSignal;
}

export interface AssessTranslationOutput {
  criteria: TranslationCriterionRating[];
  overallSummary: string;
  edits: TranslationEdit[];
}

/** Calls the MQM assessment endpoint. Throws with a readable message. */
export async function assessTranslation(
  input: AssessTranslationInput,
): Promise<AssessTranslationOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/translation/assess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    throw new Error(parsed?.error || `Assessment failed (${response.status})`);
  }
  if (input.conversationId) {
    recordWorkflowUsage(input.conversationId, parsed.data?.usage);
  }
  return parsed.data as AssessTranslationOutput;
}
