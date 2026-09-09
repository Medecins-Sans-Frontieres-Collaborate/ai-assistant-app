/**
 * Per-run token accounting for the workflow routes
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §4a).
 *
 * A workflow "run" is one user action that fans out into several model calls
 * (agentic translation = analysis + translation + up to three review rounds).
 * The collector is threaded through an orchestrator, and every call reports
 * into it as it completes.
 *
 * Recording happens PER CALL, not at run end, deliberately: the client aborts
 * the fetch on cancel, so anything held back for a final flush would be lost —
 * and those tokens were genuinely spent. `payload()` is only for the client
 * echo, which a cancelled run simply never receives.
 *
 * Region is always null (the "default" grid): workflow routes construct a
 * region-blind Azure client from the home endpoint, exactly the case
 * `estimateCO2Grams` treats as `default`.
 */
import { Session } from 'next-auth';

import { recordTokenUsage } from '@/lib/services/observability/tokenUsageRecorder';

import { RequestTelemetry } from '@/lib/types/logging';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { WorkflowCallUsage, WorkflowUsagePayload } from '@/types/workflowUsage';

/** Usage as the OpenAI SDK reports it, in either of its two shapes. */
export interface RawCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Normalizes an SDK usage object. Returns null when the provider reported
 * nothing usable — a call that yields no counts must not become a zero row.
 */
export function normalizeUsage(
  usage: RawCompletionUsage | null | undefined,
  modelId: string,
  label: string,
): WorkflowCallUsage | null {
  if (!usage) return null;
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return null;
  }
  if (promptTokens <= 0 && completionTokens <= 0) return null;
  const reported = Number(usage.total_tokens ?? 0);
  return {
    label,
    modelId,
    promptTokens,
    completionTokens,
    totalTokens:
      Number.isFinite(reported) && reported > 0
        ? reported
        : promptTokens + completionTokens,
  };
}

export interface WorkflowUsageCollectorOptions {
  user: Session['user'];
  /** The user-visible action that triggered the run ('translate', 'assess'…). */
  action: string;
  /** Client conversation id, for telemetry correlation. */
  conversationId?: string;
}

/**
 * Collects the calls of one run: records each to telemetry + the token quota
 * immediately, and accumulates them for the client echo.
 */
export class WorkflowUsageCollector {
  private readonly calls: WorkflowCallUsage[] = [];

  constructor(private readonly options: WorkflowUsageCollectorOptions) {}

  /**
   * Reports one completed model call. Never throws — telemetry must not be
   * able to fail a run whose output already exists.
   */
  record(call: WorkflowCallUsage | null | undefined): void {
    if (!call) return;
    this.calls.push(call);
    try {
      const servedConfig: OpenAIModel = OpenAIModels[
        call.modelId as OpenAIModelID
      ] ?? {
        id: call.modelId,
        name: call.modelId,
        maxLength: 0,
        tokenLimit: 0,
      };
      const telemetry: RequestTelemetry | undefined = this.options
        .conversationId
        ? { conversationId: this.options.conversationId }
        : undefined;
      recordTokenUsage(
        {
          promptTokens: call.promptTokens,
          completionTokens: call.completionTokens,
          totalTokens: call.totalTokens,
          modelId: call.modelId,
          region: null,
        },
        servedConfig,
        this.options.user,
        false,
        telemetry,
        { surface: 'workflow' },
      );
    } catch (error) {
      console.error('[workflowUsage] Failed to record call usage:', error);
    }
  }

  /** Convenience for the common "normalize then record" pair. */
  recordRaw(
    usage: RawCompletionUsage | null | undefined,
    modelId: string,
    label: string,
  ): void {
    this.record(normalizeUsage(usage, modelId, label));
  }

  get callCount(): number {
    return this.calls.length;
  }

  /** The run's totals, for the client echo. Null when nothing was recorded. */
  payload(): WorkflowUsagePayload | null {
    if (this.calls.length === 0) return null;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    for (const call of this.calls) {
      promptTokens += call.promptTokens;
      completionTokens += call.completionTokens;
      totalTokens += call.totalTokens;
    }
    return {
      action: this.options.action,
      calls: [...this.calls],
      promptTokens,
      completionTokens,
      totalTokens,
      region: null,
    };
  }
}
