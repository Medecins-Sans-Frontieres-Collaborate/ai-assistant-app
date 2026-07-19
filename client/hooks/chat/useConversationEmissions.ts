import { useMemo } from 'react';

import {
  conversationUsesAgent,
  estimateUntrackedRequests,
} from '@/lib/utils/shared/chat/usageBackfill';
import { estimateCO2Grams } from '@/lib/utils/shared/emissions';

import { Conversation, isAssistantMessageGroup } from '@/types/chat';
import { OpenAIModelID, OpenAIModels, getModelSizeClass } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

export interface ConversationEmissionsSummary {
  /** Estimated total gCO2e for the conversation (measured + back-calculated). */
  totalG: number;
  /** Portion from requests with real provider-reported token counts. */
  measuredG: number;
  /** Portion back-calculated from stored text (pre-tracking turns). */
  estimatedG: number;
  /**
   * gCO2e from this conversation's requests since local midnight ("today") —
   * the actionable figure for long-lived single conversations, where the
   * lifetime total converges to a big static number. Derived from version
   * `createdAt` timestamps; timestampless legacy turns are never "today".
   */
  todayG: number;
  todayRequests: number;
  /** The most recent request's estimate, null when there are none. */
  lastRequestG: number | null;
  /** Whether the last request had real token counts (vs back-calculated). */
  lastRequestMeasured: boolean;
  requests: number;
  hasEstimated: boolean;
}

/** ISO of local midnight — ISO strings compare lexicographically. */
function startOfTodayIso(): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/**
 * Estimated CO2e for the current conversation. Versions carrying persisted
 * `usage` use real token counts (attributed to the model that actually served
 * them); older versions are back-calculated from stored text and attributed to
 * the conversation's current model — a documented limitation stated in the
 * chip's disclaimer.
 */
export function useConversationEmissions(
  conversation: Conversation | null | undefined,
): ConversationEmissionsSummary | null {
  const models = useSettingsStore((s) => s.models);
  // Recomputed each render, constant within a day — a render after midnight
  // naturally rolls the "today" figures over via the memo dependency.
  const todayStart = startOfTodayIso();

  return useMemo(() => {
    if (!conversation || conversation.messages.length === 0) return null;
    if (conversationUsesAgent(conversation)) return null;

    const resolveModel = (modelId: string) =>
      models.find((m) => m.id === modelId) ??
      OpenAIModels[modelId as OpenAIModelID];

    // Measured: versions with persisted real usage, in entry order.
    let measuredG = 0;
    let measuredCount = 0;
    let todayG = 0;
    let todayRequests = 0;
    let lastMeasured: { entryIndex: number; gCO2e: number } | null = null;
    for (
      let entryIndex = 0;
      entryIndex < conversation.messages.length;
      entryIndex++
    ) {
      const entry = conversation.messages[entryIndex];
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
        measuredG += gCO2e;
        measuredCount += 1;
        const createdAt = 'createdAt' in version ? version.createdAt : null;
        if (createdAt != null && createdAt >= todayStart) {
          todayG += gCO2e;
          todayRequests += 1;
        }
        lastMeasured = { entryIndex, gCO2e };
      }
    }

    // Back-calculated: versions without usage. No cutoff here — per-version
    // `usage` presence is the discriminator, not timestamps.
    const conversationModel = conversation.model;
    const sizeClass = getModelSizeClass(conversationModel ?? {});
    const isDedicatedReasoner = conversationModel?.modelType === 'reasoning';
    let estimatedG = 0;
    let lastEstimated: { entryIndex: number; gCO2e: number } | null = null;
    const untracked = estimateUntrackedRequests(conversation);
    for (const request of untracked) {
      const { gCO2e } = estimateCO2Grams({
        promptTokens: request.promptTokens,
        completionTokens: request.completionTokens,
        sizeClass,
        isDedicatedReasoner,
        reasoningEffort: conversation.reasoningEffort,
        region: conversation.hostedRegion ?? null,
      });
      estimatedG += gCO2e;
      // A back-calculated turn can still be from today (its usage never
      // arrived, e.g. a failed metadata block) — count it toward "today".
      const entry = conversation.messages[request.entryIndex];
      const version =
        isAssistantMessageGroup(entry) && request.versionIndex != null
          ? entry.versions[request.versionIndex]
          : null;
      if (version?.createdAt != null && version.createdAt >= todayStart) {
        todayG += gCO2e;
        todayRequests += 1;
      }
      lastEstimated = { entryIndex: request.entryIndex, gCO2e };
    }

    const requests = measuredCount + untracked.length;
    if (requests === 0) return null;

    // "Last request" = whichever of the two appears later in entry order;
    // measured wins ties (a fresh turn always carries usage).
    let lastRequestG: number | null = null;
    let lastRequestMeasured = false;
    if (
      lastMeasured &&
      (!lastEstimated || lastMeasured.entryIndex >= lastEstimated.entryIndex)
    ) {
      lastRequestG = lastMeasured.gCO2e;
      lastRequestMeasured = true;
    } else if (lastEstimated) {
      lastRequestG = lastEstimated.gCO2e;
    }

    return {
      totalG: measuredG + estimatedG,
      measuredG,
      estimatedG,
      todayG,
      todayRequests,
      lastRequestG,
      lastRequestMeasured,
      requests,
      hasEstimated: untracked.length > 0,
    };
  }, [conversation, models, todayStart]);
}
