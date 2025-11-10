import { Message, MessageType } from '@/types/chat';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * RAGEnricher adds RAG (Retrieval Augmented Generation) capabilities to the chat.
 *
 * Responsibilities:
 * - Adds Azure AI Search data sources to chat requests
 * - Works with ANY content type (text, images, files, audio)
 * - Enriches messages with knowledge base context
 *
 * Modifies context:
 * - context.enrichedMessages (adds RAG configuration)
 *
 * Note: RAG is orthogonal to content type - you can use RAG with:
 * - Text only
 * - Text + images
 * - Text + files
 * - Text + files + images
 * - Text + audio (transcripts)
 * - Any combination
 */
export class RAGEnricher extends BasePipelineStage {
  readonly name = 'RAGEnricher';
  private tracer = trace.getTracer('rag-enricher');

  constructor(
    private searchEndpoint: string,
    private searchIndex: string,
    private searchApiKey: string,
  ) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    return !!context.botId;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return await this.tracer.startActiveSpan(
      'rag.enrich',
      {
        attributes: {
          'bot.id': context.botId || 'none',
          'search.endpoint': this.searchEndpoint,
          'search.index': this.searchIndex,
          'message.count': context.messages.length,
        },
      },
      async (span) => {
        try {
          console.log(`[RAGEnricher] Adding RAG with botId: ${context.botId}`);

          // Start with processed content if available, otherwise original messages
          const baseMessages = context.enrichedMessages || context.messages;

          // If we have processed content (files/transcripts), inject it into messages
          let enrichedMessages: Message[] = [...baseMessages];

          if (context.processedContent) {
            const { fileSummaries, transcripts } = context.processedContent;

            // Add file summaries to system context
            if (fileSummaries && fileSummaries.length > 0) {
              const summaryText = fileSummaries
                .map((f) => `File: ${f.filename}\n${f.summary}`)
                .join('\n\n');

              // Prepend as system message
              enrichedMessages = [
                {
                  role: 'system',
                  content: `The user has uploaded the following documents:\n\n${summaryText}`,
                  messageType: MessageType.TEXT,
                },
                ...enrichedMessages,
              ];
            }

            // Add transcripts to system context
            if (transcripts && transcripts.length > 0) {
              const transcriptText = transcripts
                .map(
                  (t) =>
                    `Audio/Video File: ${t.filename}\nTranscript: ${t.transcript}`,
                )
                .join('\n\n');

              enrichedMessages = [
                {
                  role: 'system',
                  content: `The user has uploaded the following audio/video files:\n\n${transcriptText}`,
                  messageType: MessageType.TEXT,
                },
                ...enrichedMessages,
              ];
            }
          }

          // RAG configuration will be added at execution time
          // We just mark that RAG should be used
          const result = {
            ...context,
            enrichedMessages,
            // Store RAG config for later use
            processedContent: {
              ...context.processedContent,
              metadata: {
                ...context.processedContent?.metadata,
                ragConfig: {
                  searchEndpoint: this.searchEndpoint,
                  searchIndex: this.searchIndex,
                  searchApiKey: this.searchApiKey,
                  botId: context.botId,
                },
              },
            },
          };

          span.setAttribute(
            'rag.file_summaries_count',
            context.processedContent?.fileSummaries?.length || 0,
          );
          span.setAttribute(
            'rag.transcripts_count',
            context.processedContent?.transcripts?.length || 0,
          );
          span.setAttribute(
            'rag.enriched_messages_count',
            enrichedMessages.length,
          );
          span.setStatus({ code: SpanStatusCode.OK });

          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
