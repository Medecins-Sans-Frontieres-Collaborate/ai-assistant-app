import {
  classifyProviderError,
  describeProviderError,
  providerErrorCode,
} from '@/lib/services/chat/providerErrors';
import {
  CONTENT_FILTER_STREAM_ERROR,
  ContinuationBudget,
  OUTPUT_LIMIT_STREAM_ERROR,
  RoundFinish,
  StreamContinuation,
  continuationActivityKey,
  normalizeAnthropicStop,
} from '@/lib/services/chat/streamContinuation';

import {
  StreamMetadata,
  TokenUsageMetadata,
  TranscriptMetadata,
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { UsageContext } from '@/lib/utils/app/stream/streamProcessor';

import { Citation } from '@/types/rag';

import { emitAgentActivity } from '@/lib/streamMarkers';
import Anthropic from '@anthropic-ai/sdk';

/** Optional behaviours of the Anthropic processor. */
export interface AnthropicStreamProcessorOptions {
  /** Mid-answer recovery — see lib/services/chat/streamContinuation.ts. */
  continuation?: StreamContinuation<Anthropic.RawMessageStreamEvent>;
}

function isControllerAlreadyClosedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE'
  );
}

/**
 * Creates a stream processor for Anthropic Claude completions.
 *
 * Anthropic streaming format uses different event types:
 * - message_start: Initial message metadata
 * - content_block_start: Start of a content block
 * - content_block_delta: Text delta with { type: 'text_delta', text: '...' }
 * - content_block_stop: End of content block
 * - message_delta: Final usage stats + stop_reason
 * - message_stop: Stream complete
 *
 * @param response - The streaming response from Anthropic
 * @param stopConversationRef - Optional reference to stop conversation flag
 * @param transcript - Optional transcript metadata for audio/video transcriptions
 * @param webSearchCitations - Optional citations from web search
 * @param usageContext - Usage attribution + sink
 * @param options - Continuation hooks
 * @returns A ReadableStream with processed text content
 */
export function createAnthropicStreamProcessor(
  response: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  stopConversationRef?: { current: boolean },
  transcript?: TranscriptMetadata,
  webSearchCitations?: Citation[],
  usageContext?: UsageContext,
  options?: AnthropicStreamProcessorOptions,
): ReadableStream {
  const continuation = options?.continuation;
  return new ReadableStream({
    start: (controller) => {
      const encoder = createStreamEncoder();
      let allContent = '';
      let allThinking = '';
      // Whether we're inside a live-streamed <think> wrapper. Thinking
      // deltas are re-emitted inline in the tag format the client already
      // parses into the collapsible ThinkingBlock, so the reasoning is
      // visible AS it happens instead of arriving silently in terminal
      // metadata.
      let thinkingOpen = false;
      let controllerClosed = false;
      // Summed across the original stream and every continuation round.
      let inputTokens = 0;
      let outputTokens = 0;
      let sawUsage = false;
      const budget = new ContinuationBudget(
        continuation?.maxInterruptionResumes,
        continuation?.maxOutputLimitContinuations,
      );

      const closeController = () => {
        if (controllerClosed) return;
        controllerClosed = true;
        try {
          controller.close();
        } catch (closeError: unknown) {
          if (!isControllerAlreadyClosedError(closeError)) {
            console.error('Error closing controller:', closeError);
          }
        }
      };

      const closeThinkBlock = () => {
        if (thinkingOpen) {
          thinkingOpen = false;
          controller.enqueue(encoder.encode('\n</think>\n\n'));
        }
      };

      /** Consume one upstream stream; returns its stop reason, or 'stopped' on user stop. */
      const consume = async (
        source: AsyncIterable<Anthropic.RawMessageStreamEvent>,
      ): Promise<RoundFinish | 'stopped'> => {
        let finish: RoundFinish = null;
        // message_delta.output_tokens is CUMULATIVE within one message —
        // track this round's last value and add it to the running total.
        let roundOutput = 0;
        for await (const event of source) {
          if (stopConversationRef?.current || controllerClosed) {
            console.log('Anthropic stream processing stopped by user');
            closeController();
            return 'stopped';
          }

          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens += event.message.usage.input_tokens ?? 0;
            sawUsage = true;
          }
          if (event.type === 'message_delta') {
            if (event.usage) {
              roundOutput = event.usage.output_tokens ?? roundOutput;
              sawUsage = true;
            }
            if (event.delta?.stop_reason) {
              finish = normalizeAnthropicStop(event.delta.stop_reason);
            }
          }

          if (event.type === 'content_block_delta') {
            const delta = event.delta;

            if (delta.type === 'text_delta' && delta.text) {
              // Thinking always precedes the answer — close the live
              // think wrapper when real content starts.
              closeThinkBlock();
              allContent += delta.text;
              controller.enqueue(encoder.encode(delta.text));
            }

            if (delta.type === 'thinking_delta' && 'thinking' in delta) {
              const thinkingChunk = (delta as Anthropic.ThinkingDelta).thinking;
              if (!thinkingOpen) {
                thinkingOpen = true;
                controller.enqueue(encoder.encode('<think>\n'));
              }
              allThinking += thinkingChunk;
              controller.enqueue(encoder.encode(thinkingChunk));
            }
          }
        }
        outputTokens += roundOutput;
        return finish;
      };

      const tryContinue = async (
        reason: 'interrupted' | 'length',
      ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent> | null> => {
        if (!continuation || !budget.take(reason)) return null;
        const attempt =
          budget.used[reason === 'length' ? 'outputLimits' : 'interruptions'];
        const key = continuationActivityKey(reason);
        continuation.onActivity?.(key);
        controller.enqueue(encoder.encode(emitAgentActivity(key)));
        try {
          return await continuation.resume(allContent, reason, attempt);
        } catch (resumeError) {
          console.error(
            `Anthropic stream continuation (${reason}) could not be opened:`,
            resumeError instanceof Error ? resumeError.message : resumeError,
          );
          return null;
        }
      };

      (async function () {
        let streamError: StreamMetadata['streamError'];
        try {
          let source = response;
          for (;;) {
            let finish: RoundFinish | 'stopped';
            try {
              finish = await consume(source);
            } catch (error: unknown) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const errorName = error instanceof Error ? error.name : 'Unknown';
              if (
                errorName === 'AbortError' ||
                errorMessage === 'Abort error: Fetch is already aborted' ||
                errorMessage?.includes('abort') ||
                errorMessage?.includes('Abort')
              ) {
                console.log(
                  'Anthropic stream aborted by user, closing cleanly',
                );
                closeController();
                return;
              }
              console.error('Anthropic stream processing error:', error);
              const classified = classifyProviderError(error);
              if (classified.kind === 'content_filter') {
                streamError = { ...CONTENT_FILTER_STREAM_ERROR };
                break;
              }
              // Upstream died after bytes already reached the client. Resume
              // from the partial on the same model when the policy allows;
              // otherwise end CLEANLY with an in-band streamError (a socket
              // abort would reach the browser as an opaque network failure
              // and trigger a silent fallback-model resend).
              const next = classified.retryable
                ? await tryContinue('interrupted')
                : null;
              if (next) {
                source = next;
                continue;
              }
              streamError = {
                code: providerErrorCode(classified.kind),
                kind: classified.kind,
                message: allContent.trim()
                  ? 'The model stopped responding before the answer was finished.'
                  : describeProviderError(classified.kind),
                ...(allContent.trim() ? {} : { retry: true }),
              };
              break;
            }
            if (finish === 'stopped') return;

            if (finish === 'content_filter') {
              streamError = { ...CONTENT_FILTER_STREAM_ERROR };
              break;
            }
            if (finish === 'length') {
              if (!allContent.trim()) {
                streamError = { ...OUTPUT_LIMIT_STREAM_ERROR };
                break;
              }
              const next = await tryContinue('length');
              if (next) {
                source = next;
                continue;
              }
            }
            break;
          }

          if (!controllerClosed) {
            // A thinking-only stream (stopped before any answer text) must
            // still close the wrapper or the open tag leaks as body text.
            closeThinkBlock();
            const allCitations: Citation[] = [];
            if (webSearchCitations && webSearchCitations.length > 0) {
              allCitations.push(...webSearchCitations);
            }
            const citations =
              allCitations.length > 0 ? allCitations : undefined;

            let transcriptMetadata: TranscriptMetadata | undefined;
            if (transcript) {
              transcriptMetadata = {
                ...transcript,
                processedContent: allContent,
              };
            }

            let usage: TokenUsageMetadata | undefined;
            if (usageContext && sawUsage) {
              usage = {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
                modelId: usageContext.modelId,
                region: usageContext.region,
                reasoningEffort: usageContext.reasoningEffort,
              };
              usageContext.onUsage?.(usage);
            }

            appendMetadataToStream(controller, {
              citations,
              thinking: allThinking || undefined,
              transcript: transcriptMetadata,
              usage,
              streamError,
            });
          }

          closeController();
        } catch (error: unknown) {
          console.error(
            'Anthropic stream processing error (post-stream):',
            error,
          );
          if (!controllerClosed) {
            controllerClosed = true;
            try {
              appendMetadataToStream(controller, {
                streamError: {
                  code: 'UPSTREAM_STREAM_FAILED',
                  message:
                    'The model stopped responding before the answer was finished.',
                },
              });
              controller.close();
            } catch {
              controller.error(error);
            }
          }
        }
      })();
    },
  });
}
