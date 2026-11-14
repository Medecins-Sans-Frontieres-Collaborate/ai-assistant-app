'use client';

import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';

import {
  ChangeEdit,
  ChangeSelection,
} from '@/lib/utils/shared/translation/changeRequest';

import { GlossaryEntry } from '@/types/workflow';

export interface RequestTranslationChangeInput {
  /** May be empty (a scanned page has no source text). */
  sourceText: string;
  translation: string;
  targetLanguage: string;
  /** The change the user asked for, in their own words. */
  instruction: string;
  /** Limits the edits to one passage of the translation. */
  selection?: ChangeSelection;
  /** The user's UI locale; decides the reply language when in doubt. */
  interfaceLocale?: string;
  glossaryEntries?: GlossaryEntry[];
  glossaryGuideIds?: string[];
  modelId?: string;
  /** Attributes the run's token spend to this conversation's ledger. */
  conversationId?: string;
  signal?: AbortSignal;
}

export interface RequestTranslationChangeOutput {
  /** What the assistant says back: what changed, or an answer. */
  reply: string;
  edits: ChangeEdit[];
}

/**
 * Asks the server to turn an instruction into edits on a translation.
 *
 * @param input - The texts, the instruction and optional scope.
 * @returns The reply and the proposed edits; nothing has been applied.
 * @throws Error with a readable message when the request fails; an aborted
 *   request rejects with the fetch AbortError.
 */
export async function requestTranslationChange(
  input: RequestTranslationChangeInput,
): Promise<RequestTranslationChangeOutput> {
  const { signal, ...body } = input;
  const response = await fetch('/api/workflows/translation/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    throw new Error(
      parsed?.error || `Change request failed (${response.status})`,
    );
  }
  if (input.conversationId) {
    recordWorkflowUsage(input.conversationId, parsed.data?.usage);
  }
  return {
    reply: typeof parsed.data?.reply === 'string' ? parsed.data.reply : '',
    edits: Array.isArray(parsed.data?.edits) ? parsed.data.edits : [],
  };
}
