'use client';

import { useMemo } from 'react';

import { estimateCO2Grams } from '@/lib/utils/shared/emissions';

import { Conversation, isAssistantMessageGroup } from '@/types/chat';
import { OpenAIModelID, OpenAIModels, getModelSizeClass } from '@/types/openai';
import { WorkflowRunUsage } from '@/types/workflowUsage';

import { artifactOf } from '@/components/Workflows/artifactKey';

import { useSettingsStore } from '@/client/stores/settingsStore';

/** One "By action" row: what a phase of the work cost. */
export interface WorkflowActionTotal {
  /** Raw label from the ledger ('translate', 'review:2', 'assess'…). */
  action: string;
  gCO2e: number;
  runs: number;
}

export interface WorkflowEmissionsSummary {
  /** Everything this workspace has spent — runs plus rail chat. */
  totalG: number;
  /** The current artifact's share of it (§7c). */
  artifactG: number;
  artifactLabel?: string;
  /** True when the artifact is the whole workspace, so the rows would agree. */
  artifactIsWorkspace: boolean;
  /** Since local midnight, on the same rule as the chat chip. */
  todayG: number;
  todayRuns: number;
  /** The most recent run, for the "Last run" line. */
  lastRun: { gCO2e: number; action: string; calls: number } | null;
  /** Per-phase split of the current artifact's spend, largest first. */
  byAction: WorkflowActionTotal[];
  /** Portion contributed by rail chat turns rather than workspace runs. */
  railG: number;
  runs: number;
}

/** ISO of local midnight — ISO strings compare lexicographically. */
function startOfTodayIso(): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/**
 * Estimated CO2e for a workflow workspace: the run ledger
 * (`conversation.workflowUsage`) plus any rail chat turns that carry
 * persisted `usage`, so ONE number means "everything this workspace did"
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §4c).
 *
 * Deliberately no back-calculation for untracked history, unlike the chat
 * chip: a workflow's output lives in `workflowState`, not the transcript, so
 * there is nothing honest to estimate from. Runs from before tracking simply
 * do not appear.
 */
export function useWorkflowEmissions(
  conversation: Conversation | null | undefined,
): WorkflowEmissionsSummary | null {
  const models = useSettingsStore((s) => s.models);
  // Recomputed each render, constant within a day — a render after midnight
  // rolls the "today" figures over via the memo dependency.
  const todayStart = startOfTodayIso();

  return useMemo(() => {
    if (!conversation) return null;
    const ledger = conversation.workflowUsage ?? [];
    const messages = conversation.messages ?? [];
    if (ledger.length === 0 && messages.length === 0) return null;

    const resolveModel = (modelId: string) =>
      models.find((m) => m.id === modelId) ??
      OpenAIModels[modelId as OpenAIModelID];

    const gramsOf = (
      run: WorkflowRunUsage,
      prompt: number,
      completion: number,
    ) => {
      const model = resolveModel(run.modelId);
      return estimateCO2Grams({
        promptTokens: prompt,
        completionTokens: completion,
        sizeClass: getModelSizeClass(model ?? {}),
        isDedicatedReasoner: model?.modelType === 'reasoning',
        reasoningEffort: run.reasoningEffort,
        region: run.region,
      }).gCO2e;
    };

    const artifact = artifactOf(conversation.workflowState);
    let totalG = 0;
    let artifactG = 0;
    let todayG = 0;
    let todayRuns = 0;
    let lastRun: WorkflowEmissionsSummary['lastRun'] = null;
    const byAction = new Map<string, WorkflowActionTotal>();

    for (const run of ledger) {
      const gCO2e = gramsOf(run, run.promptTokens, run.completionTokens);
      totalG += gCO2e;
      if (run.at >= todayStart) {
        todayG += gCO2e;
        todayRuns += 1;
      }
      lastRun = { gCO2e, action: run.action, calls: run.calls };

      if (run.artifactId !== artifact.id) continue;
      artifactG += gCO2e;
      // Phase rows come from the per-call split when the run carries one, so
      // "review rounds" can be told apart from the translation itself.
      const phases = run.byLabel?.length
        ? run.byLabel.map((entry) => ({
            action: entry.label,
            gCO2e: gramsOf(run, entry.promptTokens, entry.completionTokens),
          }))
        : [{ action: run.action, gCO2e }];
      for (const phase of phases) {
        const row = byAction.get(phase.action) ?? {
          action: phase.action,
          gCO2e: 0,
          runs: 0,
        };
        row.gCO2e += phase.gCO2e;
        row.runs += 1;
        byAction.set(phase.action, row);
      }
    }

    // Rail chat turns land as ordinary assistant messages with persisted
    // usage. Counted here so the workspace's number covers the whole surface,
    // and reported separately so the split stays legible.
    let railG = 0;
    for (const entry of messages) {
      const versions = isAssistantMessageGroup(entry)
        ? entry.versions
        : entry.role === 'assistant'
          ? [entry]
          : [];
      for (const version of versions) {
        const usage = version.usage;
        if (!usage) continue;
        const model = resolveModel(usage.modelId);
        const { gCO2e } = estimateCO2Grams({
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          sizeClass: getModelSizeClass(model ?? {}),
          isDedicatedReasoner: model?.modelType === 'reasoning',
          reasoningEffort: usage.reasoningEffort,
          region: usage.region,
        });
        railG += gCO2e;
        totalG += gCO2e;
        const createdAt = 'createdAt' in version ? version.createdAt : null;
        if (createdAt != null && createdAt >= todayStart) {
          todayG += gCO2e;
          todayRuns += 1;
        }
      }
    }

    if (totalG <= 0) return null;

    return {
      totalG,
      artifactG,
      artifactLabel: artifact.label,
      artifactIsWorkspace: artifact.id === 'workspace',
      todayG,
      todayRuns,
      lastRun,
      byAction: [...byAction.values()].sort((a, b) => b.gCO2e - a.gCO2e),
      railG,
      runs: ledger.length,
    };
  }, [conversation, models, todayStart]);
}
