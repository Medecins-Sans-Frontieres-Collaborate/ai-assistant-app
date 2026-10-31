/**
 * Mid-answer recovery shared by the stream processors and the tool loop.
 *
 * Two situations end a model stream before the answer is complete and
 * are worth continuing rather than failing:
 *
 * 1. **Interrupted**: the provider connection died (reset, 5xx mid-stream,
 *    premature close) after some text had already reached the client.
 *    Re-sending the whole turn on a fallback model would discard that text
 *    and re-run any tools; instead the transcript gets the partial answer
 *    plus a "continue" nudge and the same model picks up where it stopped.
 * 2. **Output limit**: `finish_reason: length` / `stop_reason: max_tokens`
 *    / Responses `incomplete: max_output_tokens`. The answer is not done;
 *    a nudge asks for the rest without a recap. Capped so a model that
 *    keeps hitting the limit cannot loop.
 *
 * Content-filter stops are never continued — re-asking would re-trigger
 * the filter and the user needs to know why the answer stopped.
 */

export type ContinuationReason = 'interrupted' | 'length';

/** Nudges appended as a user turn after the partial assistant text. */
export const CONTINUE_AFTER_INTERRUPTION =
  'Your previous response was interrupted before it was finished. Continue exactly where you left off. Do not apologize, recap, or repeat anything already written.';

export const CONTINUE_AFTER_OUTPUT_LIMIT =
  'Your previous response hit the output length limit before it was finished. Continue exactly where you left off. Do not apologize, recap, or repeat anything already written; if the remaining work is large, break it into smaller parts.';

export function continuationNudge(reason: ContinuationReason): string {
  return reason === 'length'
    ? CONTINUE_AFTER_OUTPUT_LIMIT
    : CONTINUE_AFTER_INTERRUPTION;
}

/** Interruptions resumed per turn before giving up. */
export const MAX_INTERRUPTION_RESUMES = 2;
/** Output-limit continuations per turn (three consecutive `length` finishes = stop). */
export const MAX_OUTPUT_LIMIT_CONTINUATIONS = 2;

/** Activity keys the loader shows while a continuation round starts. */
export const RESUME_ACTIVITY_KEY = 'chat.activity.resumingResponse';
export const CONTINUE_ACTIVITY_KEY = 'chat.activity.continuingResponse';
export const TRIM_CONTEXT_ACTIVITY_KEY = 'chat.activity.trimmingContext';

export function continuationActivityKey(reason: ContinuationReason): string {
  return reason === 'length' ? CONTINUE_ACTIVITY_KEY : RESUME_ACTIVITY_KEY;
}

/**
 * How a stream processor reopens the upstream stream to continue. The
 * service that owns the request params implements `resume`; the
 * processor only decides WHEN to call it and appends the new deltas to
 * the text the client already has.
 */
export interface StreamContinuation<TChunk> {
  /**
   * Open a continuation stream. `partialText` is everything streamed so
   * far (what the client already shows); the implementation appends it as
   * an assistant turn, adds the nudge and calls the model again. Returns
   * null to decline (e.g. non-text content the caller cannot replay).
   */
  resume(
    partialText: string,
    reason: ContinuationReason,
    attempt: number,
  ): Promise<AsyncIterable<TChunk> | null>;
  /** Emit a loader activity while the continuation starts. */
  onActivity?: (key: string, params?: Record<string, string>) => void;
  maxInterruptionResumes?: number;
  maxOutputLimitContinuations?: number;
}

/** Per-turn continuation bookkeeping shared by all processors. */
export class ContinuationBudget {
  private interruptions = 0;
  private outputLimits = 0;

  constructor(
    private readonly maxInterruptions: number = MAX_INTERRUPTION_RESUMES,
    private readonly maxOutputLimits: number = MAX_OUTPUT_LIMIT_CONTINUATIONS,
  ) {}

  /** Take one continuation of `reason`, or return false when exhausted. */
  take(reason: ContinuationReason): boolean {
    if (reason === 'length') {
      if (this.outputLimits >= this.maxOutputLimits) return false;
      this.outputLimits += 1;
      return true;
    }
    if (this.interruptions >= this.maxInterruptions) return false;
    this.interruptions += 1;
    return true;
  }

  /** Attempt number for the NEXT continuation of `reason` (1-based). */
  attemptFor(reason: ContinuationReason): number {
    return (reason === 'length' ? this.outputLimits : this.interruptions) + 1;
  }

  get used(): { interruptions: number; outputLimits: number } {
    return {
      interruptions: this.interruptions,
      outputLimits: this.outputLimits,
    };
  }
}

/**
 * Normalised terminal finish of one model round, across providers.
 * `length` = output limit, `content_filter` = provider safety stop,
 * `tool_calls` = the model wants tools, `stop` = done, `other` = anything
 * else (pause_turn, stop_sequence) — treated as done.
 */
export type RoundFinish =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'other'
  | null;

export function normalizeOpenAIFinish(
  reason: string | null | undefined,
): RoundFinish {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      return 'other';
  }
}

export function normalizeAnthropicStop(
  reason: string | null | undefined,
): RoundFinish {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    case 'tool_use':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      return 'other';
  }
}

export function normalizeResponsesIncomplete(
  reason: string | null | undefined,
): RoundFinish {
  switch (reason) {
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return null;
    default:
      return 'other';
  }
}

/** Client-facing failure for a content-filter stop (in-band streamError). */
export const CONTENT_FILTER_STREAM_ERROR = {
  code: 'MODEL_CONTENT_FILTERED',
  kind: 'content_filter' as const,
  message:
    'The response was stopped by the content safety filter. Rephrase the request, or remove the part that may have triggered it.',
};

/** Client-facing failure when the output limit was hit with NO visible text. */
export const OUTPUT_LIMIT_STREAM_ERROR = {
  code: 'MODEL_OUTPUT_LIMIT',
  kind: 'invalid_request' as const,
  message:
    'The model used its whole output budget without producing an answer (for a reasoning model, the reasoning alone filled it). Try a lower reasoning effort or a shorter request.',
};
