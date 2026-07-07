import {
  TokenUsageMetadata,
  TranscriptMetadata,
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { UsageContext } from '@/lib/utils/app/stream/streamProcessor';

import { Citation } from '@/types/rag';

import Anthropic from '@anthropic-ai/sdk';

/**
 * Creates a stream processor for Anthropic Claude completions.
 *
 * Anthropic streaming format uses different event types:
 * - message_start: Initial message metadata
 * - content_block_start: Start of a content block
 * - content_block_delta: Text delta with { type: 'text_delta', text: '...' }
 * - content_block_stop: End of content block
 * - message_delta: Final usage stats
 * - message_stop: Stream complete
 *
 * @param response - The streaming response from Anthropic
 * @param stopConversationRef - Optional reference to stop conversation flag
 * @param transcript - Optional transcript metadata for audio/video transcriptions
 * @param webSearchCitations - Optional citations from web search
 * @returns A ReadableStream with processed text content
 */
export function createAnthropicStreamProcessor(
  response: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  stopConversationRef?: { current: boolean },
  transcript?: TranscriptMetadata,
  webSearchCitations?: Citation[],
  usageContext?: UsageContext,
): ReadableStream {
  return new ReadableStream({
    start: (controller) => {
      const encoder = createStreamEncoder();
      let allContent = '';
      let allThinking = '';
      let controllerClosed = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let sawUsage = false;

      (async function () {
        try {
          for await (const event of response) {
            // Check if stopConversationRef is true before processing each chunk
            if (stopConversationRef?.current || controllerClosed) {
              console.log('Anthropic stream processing stopped by user');
              if (!controllerClosed) {
                controllerClosed = true;
                try {
                  controller.close();
                } catch (closeError: unknown) {
                  // Ignore errors if controller is already closed
                  if (
                    closeError instanceof Error &&
                    (closeError as NodeJS.ErrnoException).code !==
                      'ERR_INVALID_STATE'
                  ) {
                    console.error('Error closing controller:', closeError);
                  }
                }
              }
              return;
            }

            // Usage: message_start carries input_tokens; message_delta
            // carries CUMULATIVE output_tokens (take the last value seen).
            if (event.type === 'message_start' && event.message?.usage) {
              inputTokens = event.message.usage.input_tokens ?? 0;
              sawUsage = true;
            }
            if (event.type === 'message_delta' && event.usage) {
              outputTokens = event.usage.output_tokens ?? outputTokens;
              sawUsage = true;
            }

            // Handle content_block_delta events
            if (event.type === 'content_block_delta') {
              const delta = event.delta;

              // Handle text_delta events
              if (delta.type === 'text_delta' && delta.text) {
                const textChunk = delta.text;
                allContent += textChunk;
                controller.enqueue(encoder.encode(textChunk));
              }

              // Handle thinking_delta events (extended thinking feature)
              if (delta.type === 'thinking_delta' && 'thinking' in delta) {
                const thinkingChunk = (delta as Anthropic.ThinkingDelta)
                  .thinking;
                allThinking += thinkingChunk;
                // Note: We don't stream thinking content to the user directly
                // It will be included in metadata at the end
              }
            }
          }

          if (!controllerClosed) {
            // Merge citations
            const allCitations: Citation[] = [];
            if (webSearchCitations && webSearchCitations.length > 0) {
              allCitations.push(...webSearchCitations);
            }
            const citations =
              allCitations.length > 0 ? allCitations : undefined;

            // Build transcript metadata with LLM's processed content
            let transcriptMetadata: TranscriptMetadata | undefined;
            if (transcript) {
              transcriptMetadata = {
                filename: transcript.filename,
                transcript: transcript.transcript,
                processedContent: allContent,
              };
            }

            // Attribute captured provider usage for the client + server sinks.
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

            // Append metadata directly to controller (bypass smooth buffer)
            appendMetadataToStream(controller, {
              citations,
              thinking: allThinking || undefined,
              transcript: transcriptMetadata,
              usage,
            });
          }

          if (!controllerClosed) {
            controllerClosed = true;
            try {
              controller.close();
            } catch (closeError: unknown) {
              // Ignore errors if controller is already closed
              if (
                closeError instanceof Error &&
                (closeError as NodeJS.ErrnoException).code !==
                  'ERR_INVALID_STATE'
              ) {
                console.error('Error closing controller:', closeError);
              }
            }
          }
        } catch (error: unknown) {
          console.error('Anthropic stream processing error:', error);

          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const errorName = error instanceof Error ? error.name : 'Unknown';

          if (
            errorName === 'AbortError' ||
            errorMessage === 'Abort error: Fetch is already aborted' ||
            errorMessage?.includes('abort') ||
            errorMessage?.includes('Abort')
          ) {
            console.log('Anthropic stream aborted by user, closing cleanly');
            if (!controllerClosed) {
              controllerClosed = true;
              try {
                controller.close();
              } catch (closeError: unknown) {
                // Ignore errors if controller is already closed
                if (
                  closeError instanceof Error &&
                  (closeError as NodeJS.ErrnoException).code !==
                    'ERR_INVALID_STATE'
                ) {
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
