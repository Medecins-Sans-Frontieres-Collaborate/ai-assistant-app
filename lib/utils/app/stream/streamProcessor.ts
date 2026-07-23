import { RAGService } from '@/lib/services/ragService';

import {
  PendingTranscriptionInfo,
  TokenUsageMetadata,
  TranscriptMetadata,
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { parseThinkingContent } from '@/lib/utils/app/stream/thinking';

import { Citation } from '@/types/rag';

import { UI_CONSTANTS } from '@/lib/constants/ui';
import OpenAI from 'openai';

/**
 * True when closing a ReadableStream controller failed only because it was
 * already closed (Node throws `ERR_INVALID_STATE`). Such errors are benign and
 * shouldn't be logged.
 */
function isControllerAlreadyClosedError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ERR_INVALID_STATE';
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
 * @returns {ReadableStream} A processed stream with citation data appended.
 */
export interface UsageContext {
  modelId: string;
  region: 'US' | 'EU' | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Server-side sink (logging); runs at stream end when usage was captured. */
  onUsage?: (usage: TokenUsageMetadata) => void;
}

export function createAzureOpenAIStreamProcessor(
  response: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  ragService?: RAGService,
  stopConversationRef?: { current: boolean },
  transcript?: TranscriptMetadata,
  webSearchCitations?: Citation[],
  pendingTranscriptions?: PendingTranscriptionInfo[],
  usageContext?: UsageContext,
): ReadableStream {
  return new ReadableStream({
    start: (controller) => {
      const encoder = createStreamEncoder();
      let allContent = '';
      let controllerClosed = false;
      let capturedUsage: OpenAI.Completions.CompletionUsage | undefined;
      // Reasoning models served with a separate `reasoning_content` delta
      // field (DeepSeek-R1 on Foundry). We re-emit it inline wrapped in
      // <think> tags — the client already parses those into the collapsible
      // ThinkingBlock (and R1 variants that emit literal <think> tags in
      // `content` flow through unchanged on the same path).
      let allReasoning = '';
      let reasoningOpen = false;

      (async function () {
        try {
          for await (const chunk of response) {
            // Check if stopConversationRef is true before processing each chunk
            if (stopConversationRef?.current || controllerClosed) {
              console.log('Stream processing stopped by user');
              if (!controllerClosed) {
                controllerClosed = true;
                try {
                  controller.close();
                } catch (closeError) {
                  if (!isControllerAlreadyClosedError(closeError)) {
                    console.error('Error closing controller:', closeError);
                  }
                }
              }
              return;
            }

            // The terminal usage chunk (stream_options.include_usage) has
            // empty `choices` and a populated `usage` — capture it; the
            // content guard below is unaffected.
            if (chunk?.usage) {
              capturedUsage = chunk.usage;
            }

            // Separate reasoning channel (not part of `content`). Streamed
            // to the client immediately so the thinking is visible live.
            const reasoningChunk = (
              chunk?.choices?.[0]?.delta as
                | { reasoning_content?: string }
                | undefined
            )?.reasoning_content;
            if (reasoningChunk) {
              if (!reasoningOpen) {
                reasoningOpen = true;
                controller.enqueue(encoder.encode('<think>\n'));
              }
              allReasoning += reasoningChunk;
              controller.enqueue(encoder.encode(reasoningChunk));
            }

            if (chunk?.choices?.[0]?.delta?.content) {
              // Reasoning always precedes the answer — close the think
              // block the moment real content starts.
              if (reasoningOpen) {
                reasoningOpen = false;
                controller.enqueue(encoder.encode('\n</think>\n\n'));
              }
              const contentChunk = chunk.choices[0].delta.content;
              allContent += contentChunk;

              // Process the chunk if it's a RAG stream
              let processedChunk = contentChunk;
              if (ragService) {
                processedChunk =
                  ragService.processCitationInChunk(contentChunk);
              }

              controller.enqueue(encoder.encode(processedChunk));
            }
          }

          if (!controllerClosed) {
            // A reasoning-only stream (aborted before any answer text)
            // must still close its think block or the client renders the
            // open tag as body text forever.
            if (reasoningOpen) {
              reasoningOpen = false;
              controller.enqueue(encoder.encode('\n</think>\n\n'));
            }

            // Parse thinking content from the accumulated content
            const { thinking: inlineThinking, content } =
              parseThinkingContent(allContent);
            const thinking = allReasoning.trim() || inlineThinking;

            // Get citations if available
            let citations: Citation[] | undefined;

            // Merge citations from both RAG and web search
            const allCitations: Citation[] = [];

            // Add RAG citations if available
            if (ragService) {
              const rawCitations = ragService.getCurrentCitations();
              const uniqueCitations =
                ragService.deduplicateCitations(rawCitations);
              allCitations.push(...uniqueCitations);
            }

            // Add web search citations if available
            if (webSearchCitations && webSearchCitations.length > 0) {
              allCitations.push(...webSearchCitations);
            }

            // Only set citations if we have any
            citations = allCitations.length > 0 ? allCitations : undefined;

            // Build transcript metadata with LLM's processed content
            let transcriptMetadata: TranscriptMetadata | undefined;
            if (transcript) {
              transcriptMetadata = {
                filename: transcript.filename,
                transcript: transcript.transcript,
                processedContent: allContent, // The LLM's response about the transcript
              };
            }

            // Attribute captured provider usage (model that actually served,
            // resolved region, applied effort) for the client + server sinks.
            let usage: TokenUsageMetadata | undefined;
            if (usageContext && capturedUsage) {
              usage = {
                promptTokens: capturedUsage.prompt_tokens ?? 0,
                completionTokens: capturedUsage.completion_tokens ?? 0,
                totalTokens: capturedUsage.total_tokens ?? 0,
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
            });
          }

          if (!controllerClosed) {
            controllerClosed = true;
            try {
              controller.close();
            } catch (closeError) {
              if (!isControllerAlreadyClosedError(closeError)) {
                console.error('Error closing controller:', closeError);
              }
            }
          }
        } catch (error) {
          console.error('Stream processing error:', error);

          const err = error as { name?: string; message?: string };
          if (
            err.name === 'AbortError' ||
            err.message === 'Abort error: Fetch is already aborted' ||
            err.message?.includes('abort') ||
            err.message?.includes('Abort')
          ) {
            console.log('Stream aborted by user, closing cleanly');
            if (!controllerClosed) {
              controllerClosed = true;
              try {
                controller.close();
              } catch (closeError) {
                if (!isControllerAlreadyClosedError(closeError)) {
                  console.error('Error closing controller:', closeError);
                }
              }
            }
          } else {
            if (!controllerClosed) {
              controllerClosed = true;
              controller.error(error);
            }
          }
        }
      })();
    },
  });
}
