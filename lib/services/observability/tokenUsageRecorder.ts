/**
 * Shared per-request token-usage sink.
 *
 * ONE place that turns real provider token counts into (a) the authoritative
 * `TokenUsage` Azure Monitor event with its emissions estimate, (b) the OTel
 * counters, and (c) the soft token-quota debit — so every execution path
 * (chat.completions, Responses API, Anthropic, MCP tool-loop rounds AND the
 * Foundry agent path, which historically recorded nothing) produces identical
 * rows.
 *
 * Never throws and never awaits the sinks: telemetry must not be able to
 * delay or break a response that has already been generated.
 */
import { Session } from 'next-auth';

import { debitTokenUsage } from '@/lib/services/limits/tokenDebit';
import { getAzureMonitorLogger } from '@/lib/services/observability/AzureMonitorLoggingService';
import { MetricsService } from '@/lib/services/observability/MetricsService';

import { TokenUsageMetadata } from '@/lib/utils/app/metadata';
import { estimateCO2Grams } from '@/lib/utils/shared/emissions';

import { RequestTelemetry } from '@/lib/types/logging';
import { OpenAIModel, getModelSizeClass } from '@/types/openai';

export interface RecordTokenUsageOptions {
  /**
   * Debit the caller's `chat.tokensPerDay` / `chat.tokensPerMonth` quota
   * (docs/LIMITS.md). Default true — every model call a user triggers counts.
   */
  debit?: boolean;
}

export function recordTokenUsage(
  usage: TokenUsageMetadata,
  servedConfig: OpenAIModel,
  user: Session['user'],
  streamed: boolean,
  telemetry?: RequestTelemetry,
  options: RecordTokenUsageOptions = {},
): void {
  try {
    const sizeClass = getModelSizeClass(servedConfig);
    const estimate = estimateCO2Grams({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      sizeClass,
      isDedicatedReasoner: servedConfig.modelType === 'reasoning',
      reasoningEffort: usage.reasoningEffort,
      region: usage.region,
    });
    void getAzureMonitorLogger().logTokenUsage({
      user,
      model: usage.modelId,
      region: usage.region,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      reasoningEffort: usage.reasoningEffort,
      sizeClass,
      estimatedCO2Grams: estimate.gCO2e,
      estimatedEnergyWh: estimate.energyWh,
      assumptionsVersion: estimate.assumptionsVersion,
      streamed,
      telemetry,
    });
    MetricsService.recordTokenUsage(
      {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
      },
      {
        user,
        model: usage.modelId,
        operation: telemetry?.agentKind === 'foundry' ? 'agent' : 'chat',
        botId: telemetry?.botId,
      },
    );
    // Token quota debit (`chat.tokensPerDay` / `chat.tokensPerMonth`,
    // docs/LIMITS.md).
    //
    // ⚠ SOFT BY CONSTRUCTION, and the admin UI says so. A completion's
    // length is unknowable before it is generated, so a token limit is a
    // pre-flight READ-ONLY check plus this after-the-fact debit. A user at
    // 99% of their budget can still start a request that generates 20k
    // tokens: overshoot is bounded by the size of the completions already in
    // flight — typically one response — but it is not zero. This is inherent
    // to token accounting on any infrastructure, not a property of the blob
    // counter.
    if (options.debit !== false) {
      void debitTokenUsage(user, usage.totalTokens);
    }
  } catch (error) {
    console.error('[tokenUsageRecorder] Failed to record token usage:', error);
  }
}

/** One executed tool call, as reported by the tool loop. */
export interface ToolCallTelemetry {
  toolName: string;
  /** Connector / catalog key, or the builtin server id. */
  serverId: string;
  serverLabel: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export function recordToolCall(
  info: ToolCallTelemetry,
  modelId: string,
  user: Session['user'],
  telemetry?: RequestTelemetry,
): void {
  try {
    void getAzureMonitorLogger().logToolCall({
      user,
      toolName: info.toolName,
      toolServer: info.serverId,
      success: info.success,
      duration: info.durationMs,
      errorMessage: info.errorMessage,
      model: modelId,
      telemetry,
    });
  } catch (error) {
    console.error('[tokenUsageRecorder] Failed to record tool call:', error);
  }
}
