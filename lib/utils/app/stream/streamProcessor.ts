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
  normalizeOpenAIFinish,
} from '@/lib/services/chat/streamContinuation';
import { RAGService } from '@/lib/services/ragService';

import {
  PendingTranscriptionInfo,
  StreamMetadata,
  TokenUsageMetadata,
  TranscriptMetadata,
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { parseThinkingContent } from '@/lib/utils/app/stream/thinking';

import { Citation } from '@/types/rag';

import { emitAgentActivity } from '@/lib/streamMarkers';
import OpenAI from 'openai';

/**
 * True when closing a ReadableStream controller failed only because it was
 * already closed (Node throws `ERR_INVALID_STATE`). Such errors are benign and
 * shouldn't be logged.
 */
function isControllerAlreadyClosedError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ERR_INVALID_STATE';
}

export interface UsageContext {
  modelId: string;
  region: 'US' | 'EU' | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Server-side sink (logging); runs at stream end when usage was captured. */
  onUsage?: (usage: TokenUsageMetadata) => void;
}

/** Optional behaviours of the chat.completions processor. */
export interface OpenAIStreamProcessorOptions {
  /**
   * Mid-answer recovery (lib/services/chat/streamContinuation.ts): reopen
   * the upstream stream after an interruption or an output-limit finish and
   * keep appending to the text the client already has. Absent = the
   * historical behaviour (interruption → in-band streamError; `length` →
   * silent truncation).
   */
  continuation?: StreamContinuation<OpenAI.Chat.Completions.ChatCompletionChunk>;
}

/**
 * Creates a stream processor for Azure OpenAI completions that handles citation tracking.
 *
 * @param {AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>} response - The streaming response from OpenAI.
 * @param {RAGService} [ragService] - Optional RAG service for citation processing.
 * @param {object} [stopConversationRef] - Reference to stop conversation flag.
 * @param {TranscriptMetadata} [transcript] - Optional transcript metadata for audio/video transcriptions.
 * @param {Citation[]} [webSearchCitations] - Optional citations from web search (intelligent search mode).
 * @param {PendingTranscriptionInfo[]} [pendingTranscriptions] - Optional pending batch transcription jobs.
 * @param {UsageContext} [usageContext] - When provided, the provider's terminal
 *   usage chunk (requested via stream_options.include_usage) is attributed and
 *   forwarded in the terminal metadata block + reported via onUsage. Callers
 *   that don't pass it (RAG, document summary) see zero behavior change.
 * @param {OpenAIStreamProcessorOptions} [options] - Continuation hooks.
 * @returns {ReadableStream} A processed stream with citation data appended.
 */
export function createAzureOpenAIStreamProcessor(
  response: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  ragService?: RAGService,
  stopConversationRef?: { current: boolean },
  transcript?: TranscriptMetadata,
  webSearchCitations?: Citation[],
  pendingTranscriptions?: PendingTranscriptionInfo[],
  usageContext?: UsageContext,
  options?: OpenAIStreamProcessorOptions,
): ReadableStream {
  const continuation = options?.continuation;
  return new ReadableStream({
    start: (controller) => {
      const encoder = createStreamEncoder();
      let allContent = '';
      let controllerClosed = false;
      // Usage summed across the original stream and every continuation.
      const usageTotals = { prompt: 0, completion: 0, total: 0 };
      let sawUsage = false;
      // Reasoning models served with a separate `reasoning_content` delta
      // field (DeepSeek-R1 on Foundry). We re-emit it inline wrapped in
      // <think> tags — the client already parses those into the collapsible
      // ThinkingBlock (and R1 variants that emit literal <think> tags in
      // `content` flow through unchanged on the same path).
      let allReasoning = '';
      let reasoningOpen = false;
      const budget = new ContinuationBudget(
        continuation?.maxInterruptionResumes,
        continuation?.maxOutputLimitContinuations,
      );

      const closeController = () => {
        if (controllerClosed) return;
        controllerClosed = true;
        try {
          controller.close();
        } catch (closeError) {
          if (!isControllerAlreadyClosedError(closeError)) {
            console.error('Error closing controller:', closeError);
          }
        }
      };

      const closeThinkBlock = () => {
        if (reasoningOpen) {
          reasoningOpen = false;
          controller.enqueue(encoder.encode('\n</think>\n\n'));
        }
      };

      /** Consume one upstream stream. Returns the normalised finish, or 'stopped' when the user stopped. */
      const consume = async (
        source: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
      ): Promise<RoundFinish | 'stopped'> => {
        let finish: RoundFinish = null;
        for await (const chunk of source) {
          // Check if stopConversationRef is true before processing each chunk
          if (stopConversationRef?.current || controllerClosed) {
            console.log('Stream processing stopped by user');
            closeController();
            return 'stopped';
          }

          // The terminal usage chunk (stream_options.include_usage) has
          // empty `choices` and a populated `usage` — capture it; the
          // content guard below is unaffected.
          if (chunk?.usage) {
            sawUsage = true;
            usageTotals.prompt += chunk.usage.prompt_tokens ?? 0;
            usageTotals.completion += chunk.usage.completion_tokens ?? 0;
            usageTotals.total += chunk.usage.total_tokens ?? 0;
          }

          const choice = chunk?.choices?.[0];
          if (choice?.finish_reason) {
            finish = normalizeOpenAIFinish(choice.finish_reason);
          }

          // Separate reasoning channel (not part of `content`). Streamed
          // to the client immediately so the thinking is visible live.
          const reasoningChunk = (
            choice?.delta as { reasoning_content?: string } | undefined
          )?.reasoning_content;
          if (reasoningChunk) {
            if (!reasoningOpen) {
              reasoningOpen = true;
              controller.enqueue(encoder.encode('<think>\n'));
            }
            allReasoning += reasoningChunk;
            controller.enqueue(encoder.encode(reasoningChunk));
          }

          if (choice?.delta?.content) {
            // Reasoning always precedes the answer — close the think
            // block the moment real content starts.
            closeThinkBlock();
            const contentChunk = choice.delta.content;
            allContent += contentChunk;

            // Process the chunk if it's a RAG stream
            let processedChunk = contentChunk;
            if (ragService) {
              processedChunk = ragService.processCitationInChunk(contentChunk);
            }

            controller.enqueue(encoder.encode(processedChunk));
          }
        }
        return finish;
      };

      /**
       * Ask the continuation hook for a follow-up stream. Returns null when
       * continuation is unavailable, exhausted, or declined.
       */
      const tryContinue = async (
        reason: 'interrupted' | 'length',
      ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | null> => {
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
            `Stream continuation (${reason}) could not be opened:`,
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
            } catch (error) {
              const err = error as { name?: string; message?: string };
              if (
                err.name === 'AbortError' ||
                err.message === 'Abort error: Fetch is already aborted' ||
                err.message?.includes('abort') ||
                err.message?.includes('Abort')
              ) {
                console.log('Stream aborted by user, closing cleanly');
                closeController();
                return;
              }
              console.error('Stream processing error:', error);
              const classified = classifyProviderError(error);
              if (classified.kind === 'content_filter') {
                streamError = { ...CONTENT_FILTER_STREAM_ERROR };
                break;
              }
              // Upstream died after bytes already reached the client (mid-
              // stream 5xx, connection reset). Continue from the partial
              // text on the same model when the policy allows; otherwise
              // end CLEANLY with an in-band streamError — controller.error()
              // aborts the socket, which the browser reports as an opaque
              // network failure and the client store silently re-sends on a
              // fallback model (partial text discarded, tool calls re-run).
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
                // No text reached the client: the partial is nothing, so a
                // fallback-model resend is the right next move.
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
                // Reasoning consumed the whole budget; a "continue" nudge
                // would only do it again.
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
            // A reasoning-only stream (aborted before any answer text)
            // must still close its think block or the client renders the
            // open tag as body text forever.
            closeThinkBlock();

            // Parse thinking content from the accumulated content
            const { thinking: inlineThinking } =
              parseThinkingContent(allContent);
            const thinking = allReasoning.trim() || inlineThinking;

            // Merge citations from both RAG and web search
            const allCitations: Citation[] = [];
            if (ragService) {
              const rawCitations = ragService.getCurrentCitations();
              const uniqueCitations =
                ragService.deduplicateCitations(rawCitations);
              allCitations.push(...uniqueCitations);
            }
            if (webSearchCitations && webSearchCitations.length > 0) {
              allCitations.push(...webSearchCitations);
            }
            const citations =
              allCitations.length > 0 ? allCitations : undefined;

            // Build transcript metadata with LLM's processed content
            let transcriptMetadata: TranscriptMetadata | undefined;
            if (transcript) {
              transcriptMetadata = {
                ...transcript,
                processedContent: allContent, // The LLM's response about the transcript
              };
            }

            // Attribute captured provider usage (model that actually served,
            // resolved region, applied effort) for the client + server sinks.
            let usage: TokenUsageMetadata | undefined;
            if (usageContext && sawUsage) {
              usage = {
                promptTokens: usageTotals.prompt,
                completionTokens: usageTotals.completion,
                totalTokens: usageTotals.total,
                modelId: usageContext.modelId,
                region: usageContext.region,
                reasoningEffort: usageContext.reasoningEffort,
              };
              usageContext.onUsage?.(usage);
            }

            // Append metadata directly to controller (bypass smooth buffer)
            // Metadata should be sent immediately, not buffered
            appendMetadataToStream(controller, {
              citations,
              thinking,
              transcript: transcriptMetadata,
              pendingTranscriptions,
              usage,
              streamError,
            });
          }

          closeController();
        } catch (error) {
          console.error('Stream processing error (post-stream):', error);
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
