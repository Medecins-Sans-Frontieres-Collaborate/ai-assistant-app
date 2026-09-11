'use client';

/**
 * The ONE place a workflow run's token spend enters the client
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §4c).
 *
 * Three transports converge here — the `usage` WORKFLOW_EVENT from a streamed
 * route, the `usage` field on a JSON route's payload, and the grants poll —
 * so that the conversation ledger and the account-level totals can never
 * disagree about what a run cost.
 *
 * Both destinations take RAW token counts: CO2e is computed at display time
 * from config/emissions.json, so re-pricing the assumptions re-prices history.
 */
import { WorkflowRunUsage, WorkflowUsagePayload } from '@/types/workflowUsage';

import { artifactOf } from '@/components/Workflows/artifactKey';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { v4 as uuidv4 } from 'uuid';

/** Narrows an unknown `usage` field off an API payload. */
export function isWorkflowUsagePayload(
  value: unknown,
): value is WorkflowUsagePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<WorkflowUsagePayload>;
  return (
    typeof payload.promptTokens === 'number' &&
    typeof payload.completionTokens === 'number' &&
    Array.isArray(payload.calls)
  );
}

/** Sums a run's calls per phase, for the readout's "by action" rows. */
function splitByLabel(
  payload: WorkflowUsagePayload,
): WorkflowRunUsage['byLabel'] {
  const byLabel = new Map<
    string,
    { label: string; promptTokens: number; completionTokens: number }
  >();
  for (const call of payload.calls) {
    const entry = byLabel.get(call.label) ?? {
      label: call.label,
      promptTokens: 0,
      completionTokens: 0,
    };
    entry.promptTokens += call.promptTokens;
    entry.completionTokens += call.completionTokens;
    byLabel.set(call.label, entry);
  }
  return [...byLabel.values()];
}

/**
 * Records one completed run against a workflow conversation.
 *
 * Attribution follows the SERVED model per call, like chat's `version.usage`:
 * the account buckets are keyed on it, so a run that fell back to another
 * deployment is priced as what actually ran. The conversation ledger keeps
 * the run's dominant model for its one-line "Last run" summary.
 *
 * Safe to call with anything: a malformed or empty payload is ignored rather
 * than recorded as a zero-cost run.
 */
export function recordWorkflowUsage(
  conversationId: string,
  payload: unknown,
): void {
  if (!isWorkflowUsagePayload(payload)) return;
  if (payload.calls.length === 0) return;
  if (payload.promptTokens <= 0 && payload.completionTokens <= 0) return;

  const settings = useSettingsStore.getState();
  const conversations = useConversationStore.getState();

  // Account totals: one bucket per SERVED model, exactly as chat does it, so
  // Settings → Usage & Impact needs no special case for workflow spend.
  for (const call of payload.calls) {
    settings.recordTokenUsage({
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      totalTokens: call.totalTokens,
      modelId: call.modelId,
      region: payload.region ?? null,
    });
  }

  const conversation = conversations.conversations.find(
    (c) => c.id === conversationId,
  );
  // A run whose conversation vanished mid-flight still counted toward the
  // account total above; there is simply no ledger left to append to.
  if (!conversation) return;

  // Per-workflow-type totals for Settings → Usage & Impact (§5f). A SUBSET of
  // the model buckets written above, not an addition to them.
  if (conversation.conversationType) {
    settings.recordWorkflowTypeUsage(conversation.conversationType, {
      promptTokens: payload.promptTokens,
      completionTokens: payload.completionTokens,
    });
  }

  const artifact = artifactOf(conversation.workflowState);
  const dominant = payload.calls.reduce((best, call) =>
    call.totalTokens > best.totalTokens ? call : best,
  );

  const run: WorkflowRunUsage = {
    id: uuidv4(),
    at: new Date().toISOString(),
    action: payload.action,
    artifactId: artifact.id,
    ...(artifact.label ? { artifactLabel: artifact.label } : {}),
    modelId: dominant.modelId,
    region: payload.region ?? null,
    promptTokens: payload.promptTokens,
    completionTokens: payload.completionTokens,
    calls: payload.calls.length,
    byLabel: splitByLabel(payload),
  };
  conversations.recordWorkflowRunUsage(conversationId, run);
}
