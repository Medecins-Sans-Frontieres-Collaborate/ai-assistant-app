/**
 * The one path for helper ("auxiliary") model calls: query rewrites, routing
 * decisions, mail screening and analysis, schema proposals, MCP planning.
 *
 * A helper call sends user content (questions, conversation, mail, documents)
 * to a model, so it must honour the user's data residency exactly like the
 * chat answer. Every call therefore runs:
 *
 * 1. On the auxiliary chain for the user's region (AuxiliaryModelExecutor):
 *    only deployments verified to process data in that region are
 *    candidates, with per-deployment cooldowns, usage accounting and
 *    readiness observations. EU users always resolve EU.
 * 2. Optionally on the user's own chat model, which already runs in the
 *    user's region or on their custom-source account.
 *
 * Never on the unpinned default endpoint: a feature that hardcodes a model
 * name on the default client bypasses residency, which is what this module
 * replaces.
 *
 * Callers own their prompts, schemas and acceptance rules; this module owns
 * where the request runs.
 */
import type { StructuredDecisionFallback } from '@/lib/services/chat/routing/structuredDecisionFallback';
import type { TextCompleter } from '@/lib/services/chat/textCompletion';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import type { AuxiliaryUsageSink } from '@/types/chat';

import {
  type AuxiliaryModelExecutor,
  AuxiliaryUnavailableError,
  auxiliaryFailure,
} from './AuxiliaryModelExecutor';
import type { AuxiliaryOperation, AuxiliaryRegion } from './types';

import type OpenAI from 'openai';

type CompletionParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

/** Which path produced an answer. */
export type AuxiliaryAnswerSource = 'auxiliary' | 'chat_model';

/** A validated answer and where it came from. */
export interface AuxiliaryAnswer<T> {
  value: T;
  source: AuxiliaryAnswerSource;
  /** The model that produced the answer, when known. */
  model?: string;
}

/** Routing shared by every helper call. */
export interface AuxiliaryCallOptions {
  /** The operation (observations, cooldowns and readiness are per operation). */
  operation: AuxiliaryOperation;
  /** Residency region (auxiliaryRegion() — unknown users resolve EU). */
  region: AuxiliaryRegion;
  /** Budget for the auxiliary chain (and, by default, the whole call). */
  timeoutMs: number;
  /**
   * Budget for the chat-model fallback. Omitted: the fallback gets whatever
   * remains of `timeoutMs` (one shared deadline). Set it when the fallback
   * may legitimately take longer than the chain (a large chat model).
   */
  fallbackTimeoutMs?: number;
  /** Caller cancellation; a cancelled call never falls back. */
  signal?: AbortSignal;
  /** Token-usage sink, for both the chain and a structured fallback. */
  onUsage?: AuxiliaryUsageSink;
}

/** A structured (JSON) helper call. */
export interface AuxiliaryJsonCall<T> extends AuxiliaryCallOptions {
  /**
   * The request. `model` is ignored (the chain picks the deployment) and
   * parameters are adapted per deployment (auxiliaryParameters).
   */
  params: CompletionParams;
  /** Accepts a reply (returns the value) or rejects it (undefined). */
  accept: (response: Completion) => T | undefined;
  /** The user's chat model, held to the same `accept`. */
  fallback?: StructuredDecisionFallback;
}

/** A plain-text helper call. */
export interface AuxiliaryTextCall<T> extends AuxiliaryCallOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Output budget on the chain. */
  maxTokens: number;
  /** Output budget for the fallback (reasoning chat models need room). */
  fallbackMaxTokens?: number;
  /** Accepts reply text (returns the value) or rejects it (undefined). */
  accept: (text: string | null | undefined) => T | undefined;
  /** The user's chat model, held to the same `accept`. */
  fallback?: TextCompleter;
}

/**
 * Parses a reply's content as JSON; undefined for empty or malformed
 * content. The usual first step of an `accept` function.
 */
export function parseJsonReply(response: Completion): unknown {
  const content = response.choices[0]?.message?.content;
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * The request a plain-text helper call sends. Shared with the readiness
 * probes so a probe exercises exactly what runtime sends.
 */
export function textCallParams(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
): CompletionParams {
  return {
    model: '',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_completion_tokens: maxTokens,
  };
}

/** Wraps fallback text as a completion so one `accept` serves both paths. */
function completionFromText(text: string, modelId: string): Completion {
  return {
    id: 'chat-model-fallback',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: text, refusal: null },
      },
    ],
  };
}

/**
 * Runs helper calls on the residency chain, then the optional chat-model
 * fallback. One instance is shared process-wide (getAuxiliaryCompletions).
 */
export class AuxiliaryCompletionService {
  /**
   * @param executor - The auxiliary executor (production).
   * @param directClient - Without an executor, a plain client per region.
   *        Only for request capture (readiness probe builders) and tests;
   *        production always has the executor.
   */
  constructor(
    private readonly executor?: AuxiliaryModelExecutor,
    private readonly directClient?: (region: AuxiliaryRegion) => OpenAI,
  ) {}

  /**
   * One structured helper call.
   *
   * @returns The accepted value and its source.
   * @throws The auxiliary failure (AuxiliaryUnavailableError or the
   *         provider error) when no path produced an accepted reply; when a
   *         fallback was tried and failed too, the ORIGINAL auxiliary error,
   *         so logs name the real cause. Cancellation rethrows as-is.
   */
  async completeJson<T>(
    call: AuxiliaryJsonCall<T>,
  ): Promise<AuxiliaryAnswer<T>> {
    const started = Date.now();
    try {
      const { value, model } = await this.onChain(
        call.params,
        call.accept,
        call,
      );
      return { value, source: 'auxiliary', model };
    } catch (error) {
      const fallback = call.fallback;
      const budget = this.fallbackBudget(call, started);
      if (!fallback || call.signal?.aborted || budget === undefined)
        throw error;
      try {
        const result = await fallback(
          call.params,
          this.fallbackSignal(call.signal, budget),
        );
        if (result.usage)
          call.onUsage?.(
            {
              ...result.usage,
              modelId: result.model.id,
              region: result.region,
            },
            result.model,
            result.region,
          );
        const value = call.accept(
          completionFromText(result.text, result.model.id),
        );
        if (value === undefined)
          throw new Error(
            `${result.model.id} returned an invalid ${call.operation} reply`,
          );
        this.logFallback(call, error, result.model.id);
        return { value, source: 'chat_model', model: result.model.id };
      } catch (fallbackError) {
        this.logFallbackFailure(call, fallbackError);
        throw error;
      }
    }
  }

  /**
   * One plain-text helper call.
   *
   * @returns The accepted value and its source.
   * @throws As {@link completeJson}.
   */
  async completeText<T>(
    call: AuxiliaryTextCall<T>,
  ): Promise<AuxiliaryAnswer<T>> {
    const started = Date.now();
    const params = textCallParams(
      call.systemPrompt,
      call.userPrompt,
      call.maxTokens,
    );
    try {
      const { value, model } = await this.onChain(
        params,
        (response) => call.accept(response.choices[0]?.message?.content),
        call,
      );
      return { value, source: 'auxiliary', model };
    } catch (error) {
      const fallback = call.fallback;
      const budget = this.fallbackBudget(call, started);
      if (!fallback || call.signal?.aborted || budget === undefined)
        throw error;
      try {
        const text = await fallback(
          {
            systemPrompt: call.systemPrompt,
            userPrompt: call.userPrompt,
            maxTokens: call.fallbackMaxTokens ?? call.maxTokens,
            reasoningEffort: 'minimal',
          },
          this.fallbackSignal(call.signal, budget),
        );
        const value = call.accept(text);
        if (value === undefined)
          throw new Error(
            `The chat model returned an invalid ${call.operation} reply`,
          );
        this.logFallback(call, error, 'chat model');
        return { value, source: 'chat_model' };
      } catch (fallbackError) {
        this.logFallbackFailure(call, fallbackError);
        throw error;
      }
    }
  }

  /** The residency chain (or, without an executor, the direct client). */
  private async onChain<T>(
    params: CompletionParams,
    accept: (response: Completion) => T | undefined,
    call: AuxiliaryCallOptions,
  ): Promise<{ value: T; model?: string }> {
    if (this.executor) {
      // The executor reports each reply's candidate before validating it,
      // so the last one reported is the model behind the accepted value.
      let model: string | undefined;
      const value = await this.executor.execute(params, accept, {
        region: call.region,
        operation: call.operation,
        timeoutMs: call.timeoutMs,
        signal: call.signal,
        onUsage: (response, candidate) => {
          model = candidate.deployment.modelName;
          if (!response.usage || !call.onUsage) return;
          const servingRegion =
            candidate.reference.accountBinding === 'default'
              ? null
              : candidate.reference.accountBinding;
          call.onUsage(
            {
              modelId: candidate.deployment.modelName,
              region: servingRegion,
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            },
            candidate.model,
            servingRegion,
          );
        },
      });
      return { value, model };
    }
    if (!this.directClient)
      throw new AuxiliaryUnavailableError('endpoint_missing', call.region);
    const response = await this.directClient(
      call.region,
    ).chat.completions.create(params, {
      signal: call.signal,
      timeout: call.timeoutMs,
      maxRetries: 0,
    });
    const value = accept(response);
    if (value === undefined)
      throw new AuxiliaryUnavailableError('incompatible', call.region);
    return { value, model: response.model || undefined };
  }

  /** Milliseconds the fallback may take, or undefined when none remain. */
  private fallbackBudget(
    call: AuxiliaryCallOptions,
    started: number,
  ): number | undefined {
    if (call.fallbackTimeoutMs !== undefined) return call.fallbackTimeoutMs;
    const remaining = call.timeoutMs - (Date.now() - started);
    return remaining > 0 ? remaining : undefined;
  }

  private fallbackSignal(
    signal: AbortSignal | undefined,
    budgetMs: number,
  ): AbortSignal {
    const timeout = AbortSignal.timeout(budgetMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private logFallback(
    call: AuxiliaryCallOptions,
    auxiliaryError: unknown,
    model: string,
  ): void {
    console.warn(
      `[auxiliary] ${call.operation} (${call.region}) unavailable on the auxiliary chain (${auxiliaryFailure(auxiliaryError).reason}); answered by ${sanitizeForLog(model)} instead`,
    );
  }

  private logFallbackFailure(
    call: AuxiliaryCallOptions,
    fallbackError: unknown,
  ): void {
    console.warn(
      `[auxiliary] Chat-model fallback for ${call.operation} (${call.region}) failed:`,
      sanitizeForLog(
        fallbackError instanceof Error ? fallbackError.message : fallbackError,
      ),
    );
  }
}

let override: AuxiliaryCompletionService | undefined;

/**
 * The process-wide service, on the shared auxiliary executor. Lazy import:
 * AuxiliaryModelService pulls discovery and storage, which must not enter
 * the module graphs of lightweight callers until a call is actually made.
 */
export async function getAuxiliaryCompletions(): Promise<AuxiliaryCompletionService> {
  if (override) return override;
  const { AuxiliaryModelService } = await import('./AuxiliaryModelService');
  return AuxiliaryModelService.getInstance().completions;
}

/** Tests inject a service (usually with a direct fake client); undefined restores. */
export function setAuxiliaryCompletionsForTests(
  service: AuxiliaryCompletionService | undefined,
): void {
  override = service;
}
