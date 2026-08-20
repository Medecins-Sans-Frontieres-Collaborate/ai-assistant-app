/**
 * Back-calculates token usage for assistant turns that predate usage tracking.
 *
 * Stored messages never recorded token counts, so this walks a conversation's
 * entries and approximates each request from message text (chars/4 heuristic,
 * see tokenEstimate.ts). Two consumers:
 *  - the one-time historical backfill (AppInitializer) that seeds the
 *    settingsStore "estimated" usage buckets, and
 *  - the in-chat emissions chip, which estimates turns lacking persisted
 *    `usage` on the fly.
 *
 * Known limitation (documented in UI copy): old turns are attributed to the
 * conversation's CURRENT model/region/effort — per-message served models were
 * never recorded, so mid-conversation switches and server fallbacks are lossy.
 */
import { VALIDATION_LIMITS } from '@/lib/utils/app/const';
import { TokenUsageMetadata } from '@/lib/utils/app/metadata';
import {
  estimateMessageTokens,
  estimateTokensFromText,
} from '@/lib/utils/shared/tokenEstimate';

import { Conversation, Message, isAssistantMessageGroup } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

/**
 * Rough allowance for the scaffolding the server wraps around
 * `conversation.prompt` (base system prompt, tone/user-context additions).
 */
export const SYSTEM_PROMPT_TOKEN_ALLOWANCE = 200;

/** One approximated historical request (one assistant version). */
export interface UntrackedRequestEstimate {
  entryIndex: number;
  /** Index into the group's versions; null for a flat legacy Message. */
  versionIndex: number | null;
  promptTokens: number;
  completionTokens: number;
}

/** Structurally matches settingsStore's TokenUsageBucket. */
export interface EstimatedUsageTotals {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface EstimateUntrackedOptions {
  /**
   * Only include requests believed to predate this ISO timestamp (pass
   * `tokenUsageFirstTrackedAt` so live-tracked-then-discarded usage is never
   * double-counted). null/undefined = tracking never ran; include everything
   * lacking persisted `usage`.
   */
  onlyBeforeIso?: string | null;
}

/**
 * True when the model entry is an organization/Foundry AGENT, not a base
 * model. NOTE: `model.isAgent` must NOT be used here — on base models
 * (gpt-5.2, claude-*) it merely marks that a web-search Foundry agent is
 * AVAILABLE for them, while standard chats on those models are fully tracked.
 */
export function isAgentModel(
  model:
    | Pick<OpenAIModel, 'id' | 'modelType' | 'isOrganizationAgent'>
    | null
    | undefined,
): boolean {
  if (!model) return false;
  return (
    model.modelType === 'agent' ||
    model.isOrganizationAgent === true ||
    model.id?.startsWith('org-') === true ||
    model.id?.startsWith('foundry-') === true
  );
}

/**
 * True when the conversation EXECUTES on an agent — the Foundry path, where
 * requests leave the standard pipeline and usage isn't tracked. Keyed on the
 * MODEL being agent-shaped, not on `conversation.bot`: since the
 * agent/model decoupling a bot beside a real model is a knowledge/persona
 * ATTACHMENT that still runs on the standard path with real token usage, so
 * emissions and usage backfill must keep tracking it.
 */
export function conversationUsesAgent(conversation: Conversation): boolean {
  return isAgentModel(conversation.model ?? null);
}

/** The subset of Message/AssistantMessageVersion the walk needs. */
interface EstimableVersion {
  content: Message['content'];
  thinking?: string;
  error?: boolean;
  usage?: TokenUsageMetadata;
  createdAt?: string;
}

/**
 * Per-request token estimates for assistant turns that lack persisted `usage`.
 *
 * Models the real request shape: every request resends the prior conversation
 * AS THE PIPELINE ACTUALLY SENDS IT — windowed to the first message plus the
 * last CLIENT_MAX_MESSAGES-1 (mirroring windowMessagesForAPI), then capped at
 * the model's context window (`model.maxLength` tokens). Without both caps a
 * long-lived single conversation would grow quadratically and wildly
 * overestimate. Each version of a regenerated group was one real request;
 * only the active version's text is carried forward as later context.
 * (The window's orphaned-assistant boundary trim is ignored — at most one
 * message of drift, noise at estimate precision.)
 */
export function estimateUntrackedRequests(
  conversation: Conversation,
  opts?: EstimateUntrackedOptions,
): UntrackedRequestEstimate[] {
  const cutoff = opts?.onlyBeforeIso ?? null;
  const conversationTimestamp =
    conversation.updatedAt ?? conversation.createdAt ?? '';
  const results: UntrackedRequestEstimate[] = [];

  const systemAllowance =
    SYSTEM_PROMPT_TOKEN_ALLOWANCE +
    estimateTokensFromText(conversation.prompt ?? '');
  // NOTE: estimates assume the DEFAULT window size. Users who adjust
  // settingsStore.contextWindowSize will drift from actual request sizes —
  // accepted, since backfill is a historical estimate at best anyway.
  const windowSize = VALIDATION_LIMITS.CLIENT_MAX_MESSAGES;
  const modelContextCap =
    typeof conversation.model?.maxLength === 'number' &&
    conversation.model.maxLength > 0
      ? conversation.model.maxLength
      : Infinity;

  // Token counts of the messages sent so far, in order, plus prefix sums so
  // each request's windowed prompt is O(1): first message + last N-1.
  const sentTokens: number[] = [];
  const prefix: number[] = [0]; // prefix[i] = sum of sentTokens[0..i)
  const pushSent = (tokens: number) => {
    sentTokens.push(tokens);
    prefix.push(prefix[prefix.length - 1] + tokens);
  };
  const windowedContextTokens = (): number => {
    const count = sentTokens.length;
    const total = prefix[count];
    const windowed =
      count <= windowSize
        ? total
        : sentTokens[0] + (total - prefix[count - (windowSize - 1)]);
    return Math.min(systemAllowance + windowed, modelContextCap);
  };

  const entries = conversation.messages ?? [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];

    const isAssistantTurn =
      isAssistantMessageGroup(entry) || entry.role === 'assistant';
    if (!isAssistantTurn) {
      pushSent(estimateMessageTokens(entry.content));
      continue;
    }

    const pseudoVersions: Array<{
      version: EstimableVersion;
      versionIndex: number | null;
    }> = isAssistantMessageGroup(entry)
      ? entry.versions.map((version, versionIndex) => ({
          version,
          versionIndex,
        }))
      : [{ version: entry, versionIndex: null }];

    for (const { version, versionIndex } of pseudoVersions) {
      if (version.usage) continue; // real usage persisted → never re-estimate
      if (version.error) continue;

      const completionTokens = estimateMessageTokens(
        version.content,
        version.thinking,
      );
      if (completionTokens === 0) continue;

      const predatesCutoff =
        cutoff == null ||
        (version.createdAt != null
          ? version.createdAt < cutoff
          : conversationTimestamp < cutoff);
      if (!predatesCutoff) continue;

      results.push({
        entryIndex,
        versionIndex,
        promptTokens: windowedContextTokens(),
        completionTokens,
      });
    }

    // Only the active version's text is resent as context for later turns
    // (thinking is not resent).
    const activeVersion = isAssistantMessageGroup(entry)
      ? (entry.versions[entry.activeIndex] ??
        entry.versions[entry.versions.length - 1])
      : entry;
    if (activeVersion) {
      pushSent(estimateMessageTokens(activeVersion.content));
    }
  }

  return results;
}

/** Sums per-request estimates into one bucket (settingsStore shape). */
export function estimateConversationUsage(
  conversation: Conversation,
  opts?: EstimateUntrackedOptions,
): EstimatedUsageTotals {
  const totals: EstimatedUsageTotals = {
    promptTokens: 0,
    completionTokens: 0,
    requests: 0,
  };
  for (const request of estimateUntrackedRequests(conversation, opts)) {
    totals.promptTokens += request.promptTokens;
    totals.completionTokens += request.completionTokens;
    totals.requests += 1;
  }
  return totals;
}
