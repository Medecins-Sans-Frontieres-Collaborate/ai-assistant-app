import { RAGService } from '@/lib/services/ragService';

import {
  PendingTranscriptionInfo,
  TranscriptMetadata,
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { parseThinkingContent } from '@/lib/utils/app/stream/thinking';

import { Citation } from '@/types/rag';

import { UI_CONSTANTS } from '@/lib/constants/ui';
import OpenAI from 'openai';

/**
 * Creates a stream processor for Azure OpenAI completions that handles citation tracking.
 *
 * @param {AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>} response - The streaming response from OpenAI.
 * @param {RAGService} [ragService] - Optional RAG service for citation processing.
 * @param {object} [stopConversationRef] - Reference to stop conversation flag.
 * @param {TranscriptMetadata} [transcript] - Optional transcript metadata for audio/video transcriptions.
 * @param {Citation[]} [webSearchCitations] - Optional citations from web search (intelligent search mode).
 * @param {PendingTranscriptionInfo[]} [pendingTranscriptions] - Optional pending batch transcription jobs.
 * @returns {ReadableStream} A processed stream with citation data appended.
 */
export function createAzureOpenAIStreamProcessor(
  response: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  ragService?: RAGService,
  stopConversationRef?: { current: boolean },
  transcript?: TranscriptMetadata,
  webSearchCitations?: Citation[],
  pendingTranscriptions?: PendingTranscriptionInfo[],
): ReadableStream {
  return new ReadableStream({
    start: (controller) => {
      const encoder = createStreamEncoder();
      let allContent = '';
      let controllerClosed = false;

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
                } catch (closeError: any) {
                  // Ignore errors if controller is already closed
                  if (closeError.code !== 'ERR_INVALID_STATE') {
                    console.error('Error closing controller:', closeError);
                  }
                }
              }
              return;
            }

            if (chunk?.choices?.[0]?.delta?.content) {
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
            // Parse thinking content from the accumulated content
            const { thinking, content } = parseThinkingContent(allContent);

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

            // Append metadata directly to controller (bypass smooth buffer)
            // Metadata should be sent immediately, not buffered
            appendMetadataToStream(controller, {
              citations,
              thinking,
              transcript: transcriptMetadata,
              pendingTranscriptions,
            });
          }

          if (!controllerClosed) {
            controllerClosed = true;
            try {
              controller.close();
            } catch (closeError: any) {
              // Ignore errors if controller is already closed
              if (closeError.code !== 'ERR_INVALID_STATE') {
                console.error('Error closing controller:', closeError);
              }
            }
          }
        } catch (error: any) {
          console.error('Stream processing error:', error);

          if (
            error.name === 'AbortError' ||
            error.message === 'Abort error: Fetch is already aborted' ||
            error.message?.includes('abort') ||
            error.message?.includes('Abort')
          ) {
            console.log('Stream aborted by user, closing cleanly');
            if (!controllerClosed) {
              controllerClosed = true;
              try {
                controller.close();
              } catch (closeError: any) {
                // Ignore errors if controller is already closed
                if (closeError.code !== 'ERR_INVALID_STATE') {
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
