import { useMemo } from 'react';

import { estimateRequestUsd } from '@/lib/utils/shared/chat/requestCost';
import {
  conversationUsesAgent,
  estimateUntrackedRequests,
} from '@/lib/utils/shared/chat/usageBackfill';

import { Conversation, isAssistantMessageGroup } from '@/types/chat';

import { useSettingsStore } from '@/client/stores/settingsStore';

export interface ConversationCostSummary {
  /** Estimated list-price USD for the conversation (measured + back-calculated). */
  totalUsd: number;
  /** Portion from requests with real provider-reported token counts. */
  measuredUsd: number;
  /** Portion back-calculated from stored text (pre-tracking turns). */
  estimatedUsd: number;
  /** USD from this conversation's requests since local midnight. */
  todayUsd: number;
  todayRequests: number;
  /** The most recent PRICED request's estimate, null when there is none. */
  lastRequestUsd: number | null;
  /** Every request seen, priced or not. */
  requests: number;
  pricedRequests: number;
  /** Requests whose model has no list price (unknown id, BYO, local, agent). */
  unpricedRequests: number;
  hasEstimated: boolean;
}

/** ISO of local midnight — ISO strings compare lexicographically. */
function startOfTodayIso(): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/**
 * Estimated list-price cost of the current conversation — the money twin of
 * `useConversationEmissions`, walking the same requests with the same
 * measured / back-calculated split and the same "today" rule, so the two
 * figures in the chip always describe the same set of turns.
 *
 * Null for empty and agent conversations (agent turns report no tokens).
 * A conversation whose every request is unpriced still returns a summary
 * (`pricedRequests: 0`) so the chip can say WHY no cost is shown.
 */
export function useConversationCost(
  conversation: Conversation | null | undefined,
): ConversationCostSummary | null {
  const models = useSettingsStore((s) => s.models);
  const todayStart = startOfTodayIso();

  return useMemo(() => {
    if (!conversation || conversation.messages.length === 0) return null;
    if (conversationUsesAgent(conversation)) return null;

    let measuredUsd = 0;
    let estimatedUsd = 0;
    let todayUsd = 0;
    let todayRequests = 0;
    let pricedRequests = 0;
    let unpricedRequests = 0;
    let estimatedPriced = 0;
    let lastMeasured: { entryIndex: number; usd: number } | null = null;
    let lastEstimated: { entryIndex: number; usd: number } | null = null;

    // Measured: versions with persisted real usage, attributed to the model
    // that actually served them.
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
        const result = estimateRequestUsd({
          modelId: usage.modelId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningEffort: usage.reasoningEffort,
          liveModels: models,
        });
        if (result.usd === undefined) {
          unpricedRequests += 1;
          continue;
        }
        pricedRequests += 1;
        measuredUsd += result.usd;
        const createdAt = 'createdAt' in version ? version.createdAt : null;
        if (createdAt != null && createdAt >= todayStart) {
          todayUsd += result.usd;
          todayRequests += 1;
        }
        lastMeasured = { entryIndex, usd: result.usd };
      }
    }

    // Back-calculated: versions without usage, priced at the conversation's
    // current model — the same documented limitation as the emissions figure.
    const conversationModelId = conversation.model?.id ?? '';
    for (const request of estimateUntrackedRequests(conversation)) {
      const result = estimateRequestUsd({
        modelId: conversationModelId,
        promptTokens: request.promptTokens,
        completionTokens: request.completionTokens,
        reasoningEffort: conversation.reasoningEffort,
        liveModels: models,
      });
      if (result.usd === undefined) {
        unpricedRequests += 1;
        continue;
      }
      pricedRequests += 1;
      estimatedPriced += 1;
      estimatedUsd += result.usd;
      const entry = conversation.messages[request.entryIndex];
      const version =
        isAssistantMessageGroup(entry) && request.versionIndex != null
          ? entry.versions[request.versionIndex]
          : null;
      if (version?.createdAt != null && version.createdAt >= todayStart) {
        todayUsd += result.usd;
        todayRequests += 1;
      }
      lastEstimated = { entryIndex: request.entryIndex, usd: result.usd };
    }

    const requests = pricedRequests + unpricedRequests;
    if (requests === 0) return null;

    let lastRequestUsd: number | null = null;
    if (
      lastMeasured &&
      (!lastEstimated || lastMeasured.entryIndex >= lastEstimated.entryIndex)
    ) {
      lastRequestUsd = lastMeasured.usd;
    } else if (lastEstimated) {
      lastRequestUsd = lastEstimated.usd;
    }

    return {
      totalUsd: measuredUsd + estimatedUsd,
      measuredUsd,
      estimatedUsd,
      todayUsd,
      todayRequests,
      lastRequestUsd,
      requests,
      pricedRequests,
      unpricedRequests,
      hasEstimated: estimatedPriced > 0,
    };
  }, [conversation, models, todayStart]);
}
