import { getAzureMonitorLogger } from '@/lib/services/observability';
import { resolveOrgAgentById } from '@/lib/services/orgAgents/orgAgentRegistry';
import { RAGService } from '@/lib/services/ragService';

import { buildConversationContextSections } from '@/lib/utils/app/systemPrompt';

import { Message, MessageType } from '@/types/chat';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import OpenAI from 'openai';

/**
 * RAGEnricher adds RAG (Retrieval Augmented Generation) capabilities to the chat.
 *
 * Responsibilities:
 * - Adds Azure AI Search data sources to chat requests
 * - Works with ANY content type (text, images, files, audio)
 * - Enriches messages with knowledge base context
 * - Gets organization agent configuration for custom system prompts and RAG settings
 *
 * Modifies context:
 * - context.enrichedMessages (adds RAG configuration)
 * - context.systemPrompt (overrides with organization agent's system prompt)
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
  private searchEndpoint: string;
  private searchIndex: string;
  private openAIClient: OpenAI;
  /**
   * One RAGService per search index: admin-authored org agents (and static
   * entries with a `ragConfig.searchIndex` override) query their own index
   * on the shared endpoint, everything else rides the default.
   */
  private ragServicesByIndex = new Map<string, RAGService>();

  constructor(
    searchEndpoint: string,
    searchIndex: string,
    openAIClient: OpenAI,
  ) {
    super();
    this.searchEndpoint = searchEndpoint;
    this.searchIndex = searchIndex;
    this.openAIClient = openAIClient;
  }

  private ragServiceForIndex(searchIndex: string): RAGService {
    let service = this.ragServicesByIndex.get(searchIndex);
    if (!service) {
      service = new RAGService(
        this.searchEndpoint,
        searchIndex,
        this.openAIClient,
      );
      this.ragServicesByIndex.set(searchIndex, service);
    }
    return service;
  }

  shouldRun(context: ChatContext): boolean {
    // botId is used for organization agent ID (e.g., "msf_communications").
    // Prompt agents and M365 file-backed agents also arrive via botId but
    // are handled by their own enrichers — they must never trigger an org
    // knowledge-base search.
    return !!context.botId && !context.promptAgent && !context.m365Agent;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return await this.tracer.startActiveSpan(
      'rag.enrich',
      {
        attributes: {
          'organization_agent.id': context.botId || 'none',
          'search.endpoint': this.searchEndpoint,
          'search.index': this.searchIndex,
          'message.count': context.messages.length,
        },
      },
      async (span) => {
        try {
          console.log(
            `[RAGEnricher] Adding RAG with organization agent: ${context.botId}`,
          );

          // Resolve through the org-agent registry: static config merged
          // with admin-authored records (admin wins — including disables).
          const agent = context.botId
            ? await resolveOrgAgentById(context.botId)
            : undefined;

          if (!agent) {
            console.warn(
              `[RAGEnricher] Organization agent not found: ${context.botId}`,
            );
            span.setAttribute('rag.agent_found', false);
            span.setStatus({ code: SpanStatusCode.OK });
            return context;
          }

          // Tell the client we're about to hit the knowledge base — Azure
          // Search round-trips can take several seconds for large indices.
          await context.emitActivity?.('chat.activity.searchingKnowledge');

          console.log(`[RAGEnricher] Found organization agent: ${agent.name}`);

          // Start with processed content if available, otherwise original messages
          const baseMessages = context.enrichedMessages || context.messages;
          let enrichedMessages: Message[] = [...baseMessages];

          // If we have processed content (files/transcripts), inject it into messages
          if (context.processedContent) {
            const { fileSummaries, inlineFiles, transcripts } =
              context.processedContent;

            if (fileSummaries && fileSummaries.length > 0) {
              const summaryText = fileSummaries
                .map((f) => `Document summary: ${f.filename}\n${f.summary}`)
                .join('\n\n');

              enrichedMessages = [
                {
                  role: 'system',
                  content: `The user has uploaded the following documents (summarized from large files):\n\n${summaryText}`,
                  messageType: MessageType.TEXT,
                },
                ...enrichedMessages,
              ];
            }

            if (inlineFiles && inlineFiles.length > 0) {
              const inlineText = inlineFiles
                .map((f) => '```' + f.filename + '\n' + f.content + '\n```')
                .join('\n\n');

              enrichedMessages = [
                {
                  role: 'system',
                  content: `The user has uploaded the following documents:\n\n${inlineText}`,
                  messageType: MessageType.TEXT,
                },
                ...enrichedMessages,
              ];
            }

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

          // Perform the RAG search to get relevant documents
          const agentSearchIndex =
            agent.ragConfig?.searchIndex || this.searchIndex;
          console.log(
            `[RAGEnricher] Performing search for agent: ${agent.id} (index: ${agentSearchIndex})`,
          );
          const { searchDocs, searchMetadata } = await this.ragServiceForIndex(
            agentSearchIndex,
          ).performSearch(enrichedMessages, agent, context.user);

          console.log(
            `[RAGEnricher] Search returned ${searchDocs.length} documents`,
          );
          span.setAttribute('rag.search_results_count', searchDocs.length);
          span.setAttribute(
            'rag.date_range',
            `${searchMetadata.dateRange.oldest} to ${searchMetadata.dateRange.newest}`,
          );

          // Format search results as context for the LLM
          if (searchDocs.length > 0) {
            const contextString = searchDocs
              .map((doc, index) => {
                const sourceNumber = index + 1;
                const date = new Date(doc.date).toISOString().split('T')[0];
                return `Source ${sourceNumber}:\nTitle: ${doc.title}\nDate: ${date}\nURL: ${doc.url}\nContent: ${doc.chunk}`;
              })
              .join('\n\n');

            // Add RAG context as a system message
            enrichedMessages = [
              {
                role: 'system',
                content: `You have access to the following knowledge base sources. When citing information, use source numbers in SEPARATE brackets like [1][2][3] - never group them like [1,2,3].\n\nAvailable sources:\n\n${contextString}`,
                messageType: MessageType.TEXT,
              },
              ...enrichedMessages,
            ];
          }

          // Convert search results to citations format for downstream handlers
          const citations = searchDocs.map((doc, index) => ({
            title: doc.title,
            date: doc.date,
            url: doc.url,
            number: index + 1,
          }));

          // Summary/memories sections already live in context.systemPrompt
          // (buildSystemPrompt); re-append them when the org agent's own
          // prompt replaces it so RAG requests keep the sections.
          const conversationContext = buildConversationContextSections(
            context.conversationSummary,
            context.memories,
          );

          // Store metadata for downstream processing (citations, etc.)
          const result = {
            ...context,
            enrichedMessages,
            // Override system prompt with organization agent's system prompt
            systemPrompt:
              agent.systemPrompt && conversationContext
                ? `${agent.systemPrompt}\n\n${conversationContext}`
                : agent.systemPrompt || context.systemPrompt,
            processedContent: {
              ...context.processedContent,
              metadata: {
                ...context.processedContent?.metadata,
                // Citations in format expected by StandardChatHandler
                citations,
                ragConfig: {
                  searchEndpoint: this.searchEndpoint,
                  searchIndex: agentSearchIndex,
                  organizationAgentId: context.botId,
                  agentName: agent.name,
                  agentSources: agent.sources,
                  searchResults: searchDocs,
                  searchMetadata,
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
          span.setAttribute('rag.agent_name', agent.name);
          span.setStatus({ code: SpanStatusCode.OK });

          // Log RAG configuration (the actual search is performed by Azure OpenAI)
          // This gives us visibility into RAG usage patterns
          // Note: Query content intentionally omitted for user privacy
          const logger = getAzureMonitorLogger();
          void logger.logSearch({
            user: context.user,
            query: '', // Privacy: user query content not logged
            resultCount: 0, // Results come from Azure OpenAI, we don't have visibility
            searchType: 'semantic',
            indexName: agentSearchIndex,
            botId: context.botId,
            telemetry: context.telemetry,
          });

          return result;
        } catch (error) {
          console.error('[RAGEnricher] Error during RAG enrichment:', error);
          // Log RAG error to Azure Monitor
          const logger = getAzureMonitorLogger();
          void logger.logSearchError({
            user: context.user,
            indexName: this.searchIndex,
            errorCode: 'RAG_ENRICHMENT_FAILED',
            errorMessage:
              error instanceof Error ? error.message : 'Unknown error',
            botId: context.botId,
            telemetry: context.telemetry,
          });

          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          // Gracefully degrade - continue without RAG results instead of failing the request
          console.warn(
            '[RAGEnricher] Continuing without RAG results due to error',
          );
          return context;
        } finally {
          span.end();
        }
      },
    );
  }
}
