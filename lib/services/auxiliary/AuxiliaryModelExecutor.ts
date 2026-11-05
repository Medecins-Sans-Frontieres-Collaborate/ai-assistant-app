/** Bounded, residency-filtered inference attempts shared by auxiliary operations. */
import { countTokens } from '@/lib/utils/server/tiktoken/tiktokenCache';

import {
  AUXILIARY_LIMITS,
  type AuxiliaryCandidate,
  type AuxiliaryFailure,
  type AuxiliaryObservation,
  type AuxiliaryOperation,
  type AuxiliaryRegion,
  referenceKey,
} from './types';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import type OpenAI from 'openai';

export interface AuxiliaryExecutionOptions {
  region: AuxiliaryRegion;
  operation: AuxiliaryOperation;
  timeoutMs?: number;
  signal?: AbortSignal;
  source?: 'runtime' | 'probe';
  candidates?: AuxiliaryCandidate[];
  onUsage?: (
    response: OpenAI.Chat.Completions.ChatCompletion,
    candidate: AuxiliaryCandidate,
  ) => void;
}
export interface AuxiliaryExecutionDependencies {
  resolve: (
    operation: AuxiliaryOperation,
    region: AuxiliaryRegion,
  ) => Promise<{ candidates: AuxiliaryCandidate[]; revision: string }>;
  client: (candidate: AuxiliaryCandidate) => OpenAI | undefined;
  observe: (entry: AuxiliaryObservation) => void;
  environment: string;
}

/** Typed unavailable outcome; callers keep their existing graceful fallback. */
export class AuxiliaryUnavailableError extends Error {
  constructor(
    public readonly reason: AuxiliaryFailure,
    public readonly region: AuxiliaryRegion,
  ) {
    super(`Auxiliary ${region} inference unavailable (${reason})`);
    this.name = 'AuxiliaryUnavailableError';
  }
}

/** Classify provider failures without placing raw request/provider details in diagnostics. */
export function auxiliaryFailure(error: unknown): {
  reason: AuxiliaryFailure;
  status?: number;
  account: boolean;
} {
  const status =
    Number((error as { status?: unknown } | null)?.status) || undefined;
  const message = error instanceof Error ? error.message : '';
  if (error instanceof AuxiliaryUnavailableError)
    return { reason: error.reason, account: false };
  if (status === 401 || status === 403)
    return { reason: 'unauthorized', status, account: true };
  if (status === 404)
    return { reason: 'deployment_missing', status, account: false };
  if (status === 429) return { reason: 'throttled', status, account: true };
  if (status === 400 || status === 422)
    return { reason: 'incompatible', status, account: false };
  if (
    /timeout|timed out|abort/i.test(message) ||
    /abort/i.test((error as Error)?.name ?? '')
  )
    return { reason: 'timeout', status, account: false };
  return {
    reason: 'provider',
    status,
    account: /ENOTFOUND|ECONNREFUSED|credential/i.test(message),
  };
}

/** Adapt supported parameters to the actual serving model; never infer reasoning from its name. */
export function auxiliaryParameters(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  candidate: AuxiliaryCandidate,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const {
    reasoning_effort: _reasoning,
    max_completion_tokens: cap,
    max_tokens: oldCap,
    ...rest
  } = params;
  const openai = candidate.deployment.publisher?.toLowerCase() === 'openai';
  const reasons = candidate.model.supportsReasoningEffort === true;
  return {
    ...rest,
    model: candidate.reference.deploymentName,
    ...(openai
      ? {
          max_completion_tokens: Math.min(
            cap ?? oldCap ?? 256,
            candidate.model.tokenLimit,
          ),
        }
      : {
          max_tokens: Math.min(
            cap ?? oldCap ?? 256,
            candidate.model.tokenLimit,
          ),
        }),
    ...(openai && reasons
      ? {
          reasoning_effort: candidate.model.supportsMinimalReasoning
            ? ('minimal' as const)
            : ('low' as const),
        }
      : {}),
    ...(!openai && params.response_format
      ? { response_format: { type: 'json_object' as const } }
      : {}),
  };
}

/** Shared executor. Dependency injection keeps provider/discovery/storage seams independently testable. */
export class AuxiliaryModelExecutor {
  private cooldowns = new Map<
    string,
    { until: number; reason: AuxiliaryFailure }
  >();
  constructor(private readonly dependencies: AuxiliaryExecutionDependencies) {}

  /** Clear process-local failure cooldowns after an explicit administrator recheck. */
  resetCooldowns(): void {
    this.cooldowns.clear();
  }

  /**
   * Run at most three provider attempts within ONE deadline. Validator failures
   * can fall back; refusals/cancellation never do. Returns the caller's validated
   * value, or throws a typed unavailable outcome. Usage sinks cannot affect inference.
   */
  async execute<T>(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    validate: (
      response: OpenAI.Chat.Completions.ChatCompletion,
    ) => T | undefined,
    options: AuxiliaryExecutionOptions,
  ): Promise<T> {
    const timeout = Math.max(
      1,
      options.timeoutMs ?? AUXILIARY_LIMITS.routingMs,
    );
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeout),
      ...(options.signal ? [options.signal] : []),
    ]);
    const deadline = Date.now() + timeout;
    return trace
      .getTracer('auxiliary-models')
      .startActiveSpan('auxiliary.execute', async (span) => {
        span.setAttributes({
          'auxiliary.environment': this.dependencies.environment,
          'auxiliary.operation': options.operation,
          'auxiliary.region': options.region,
        });
        let reason: AuxiliaryFailure = 'inventory_unavailable';
        try {
          for (const [key, entry] of this.cooldowns)
            if (entry.until <= Date.now()) this.cooldowns.delete(key);
          const resolution = await abortable(
            this.dependencies.resolve(options.operation, options.region),
            signal,
          );
          const candidates = options.candidates ?? resolution.candidates;
          const inputTokens = await abortable(
            countTokens(JSON.stringify(params.messages)),
            signal,
          );
          let attempts = 0;
          for (
            let index = 0;
            index < candidates.length && attempts < AUXILIARY_LIMITS.attempts;
            index++
          ) {
            if (signal.aborted) break;
            const candidate = candidates[index];
            if (
              inputTokens +
                Math.min(
                  params.max_completion_tokens ?? params.max_tokens ?? 256,
                  candidate.model.tokenLimit,
                ) >
              candidate.model.maxLength
            ) {
              reason = 'incompatible';
              continue;
            }
            const accountKey = `${resolution.revision}|${candidate.endpoint}`;
            const key = `${accountKey}|${candidate.fingerprint}|${options.operation}`;
            const cooling = [
              this.cooldowns.get(accountKey),
              this.cooldowns.get(key),
            ].find((entry) => entry && entry.until > Date.now());
            if (cooling && options.source !== 'probe') {
              reason = cooling.reason;
              continue;
            }
            const client = this.dependencies.client(candidate);
            if (!client) {
              reason = 'endpoint_missing';
              continue;
            }
            attempts++;
            const started = Date.now();
            const remainingAttempts = Math.min(
              AUXILIARY_LIMITS.attempts - attempts + 1,
              candidates.length - index,
            );
            const budget = Math.max(
              1,
              Math.floor((deadline - started) / remainingAttempts),
            );
            const attemptSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(budget),
            ]);
            let success = false;
            let status: number | undefined;
            try {
              const response = await abortable(
                client.chat.completions.create(
                  auxiliaryParameters(params, candidate),
                  { signal: attemptSignal, timeout: budget, maxRetries: 0 },
                ),
                attemptSignal,
              );
              try {
                options.onUsage?.(response, candidate);
              } catch {
                console.warn('[auxiliary] Usage sink failed');
              }
              if (
                response.choices[0]?.message.refusal ||
                response.choices[0]?.finish_reason === 'content_filter'
              )
                throw new AuxiliaryUnavailableError('refused', options.region);
              const value = validate(response);
              if (
                value === undefined ||
                response.choices[0]?.finish_reason === 'length'
              )
                throw new AuxiliaryUnavailableError(
                  'incompatible',
                  options.region,
                );
              success = true;
              this.cooldowns.delete(key);
              this.cooldowns.delete(accountKey);
              span.setAttributes({
                'auxiliary.deployment': candidate.reference.deploymentName,
                'auxiliary.model': candidate.deployment.modelName,
                'auxiliary.fallback': (candidate.priority ?? index) > 0,
                'auxiliary.attempts': attempts,
              });
              span.setStatus({ code: SpanStatusCode.OK });
              return value;
            } catch (error) {
              if (options.signal?.aborted) throw error;
              const failure = auxiliaryFailure(error);
              reason = failure.reason;
              status = failure.status;
              if (reason === 'refused') throw error;
              this.cooldowns.set(failure.account ? accountKey : key, {
                until:
                  Date.now() +
                  (reason === 'deployment_missing'
                    ? AUXILIARY_LIMITS.missingCooldownMs
                    : AUXILIARY_LIMITS.cooldownMs),
                reason,
              });
            } finally {
              if (!options.signal?.aborted) {
                try {
                  this.dependencies.observe({
                    key: referenceKey(candidate.reference),
                    operation: options.operation,
                    fingerprint: candidate.fingerprint,
                    policyRevision: resolution.revision,
                    checkedAt: new Date().toISOString(),
                    success,
                    reason: success ? undefined : reason,
                    httpStatus: status,
                    durationMs: Date.now() - started,
                    source: options.source ?? 'runtime',
                    fallback: (candidate.priority ?? index) > 0,
                  });
                } catch {
                  console.warn('[auxiliary] Observation sink failed');
                }
              }
            }
          }
          throw new AuxiliaryUnavailableError(
            signal.aborted ? 'timeout' : reason,
            options.region,
          );
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: 'Auxiliary operation unavailable',
          });
          span.setAttribute(
            'auxiliary.failure',
            auxiliaryFailure(error).reason,
          );
          throw error;
        } finally {
          span.end();
        }
      });
  }
}

/** Await a dependency while honouring cancellation even if its SDK ignores signals. */
async function abortable<T>(
  work: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
