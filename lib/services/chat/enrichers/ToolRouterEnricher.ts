import { Message, MessageType, ToolRouterRequest } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AgentChatService } from '../AgentChatService';
import { ToolRouterService } from '../ToolRouterService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import { WebSearchTool } from '../tools/WebSearchTool';

import { getOrganizationAgentById } from '@/lib/organizationAgents';

/**
 * ToolRouterEnricher adds intelligent tool routing capabilities.
 *
 * Responsibilities:
 * - Determines if web search is needed (INTELLIGENT mode)
 * - Forces web search (ALWAYS mode)
 * - Executes search as a tool
 * - Adds search results to messages
 *
 * Modifies context:
 * - context.enrichedMessages (adds search results)
 *
 * Note: This enricher runs AFTER content processing, so it can work with:
 * - Raw text queries
 * - Queries about uploaded files
 * - Queries about images
 * - Queries about transcribed audio
 */
export class ToolRouterEnricher extends BasePipelineStage {
  readonly name = 'ToolRouterEnricher';

  private toolRouterService: ToolRouterService;
  private webSearchTool: WebSearchTool;

  constructor(
    toolRouterService: ToolRouterService,
    agentChatService: AgentChatService,
  ) {
    super();
    this.toolRouterService = toolRouterService;
    this.webSearchTool = new WebSearchTool(agentChatService);
  }

  shouldRun(context: ChatContext): boolean {
    // Check if org agent allows web search
    if (context.botId) {
      const agent = getOrganizationAgentById(context.botId);
      if (agent?.allowWebSearch) {
        return (
          context.searchMode === SearchMode.INTELLIGENT ||
          context.searchMode === SearchMode.ALWAYS
        );
      }
      return false; // Org agent without allowWebSearch - no web search
    }

    // Standard search mode check for non-org-agent models
    return (
      context.searchMode === SearchMode.INTELLIGENT ||
      context.searchMode === SearchMode.ALWAYS
    );
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    // Start with current messages (may already be enriched by RAG)
    const baseMessages = context.enrichedMessages || context.messages;

    // Extract the last message text for tool routing decision
    const lastMessage = baseMessages[baseMessages.length - 1];
    let currentMessage = this.extractTextFromContent(lastMessage.content);

    // IMPORTANT: Include processed file summaries and transcripts in the analysis
    // This ensures the tool router can see the full context when deciding if web search is needed
    if (context.processedContent) {
      const additionalContext: string[] = [];

      // Add file summaries
      if (context.processedContent.fileSummaries) {
        const summaries = context.processedContent.fileSummaries
          .map((f) => `[File: ${f.filename}]\n${f.summary}`)
          .join('\n\n');
        additionalContext.push(summaries);
      }

      // Add inline file content
      if (context.processedContent.inlineFiles) {
        const inlineText = context.processedContent.inlineFiles
          .map((f) => `[File: ${f.filename}]\n${f.content}`)
          .join('\n\n');
        additionalContext.push(inlineText);
      }

      // Add transcripts
      if (context.processedContent.transcripts) {
        const transcripts = context.processedContent.transcripts
          .map((t) => `[Audio/Video: ${t.filename}]\n${t.transcript}`)
          .join('\n\n');
        additionalContext.push(transcripts);
      }

      // Merge with user's message
      if (additionalContext.length > 0) {
        currentMessage = `${currentMessage}\n\n${additionalContext.join('\n\n')}`;
      }
    }

    // Determine which tools are needed
    const forceWebSearch = context.searchMode === SearchMode.ALWAYS;
    const toolRouterRequest: ToolRouterRequest = {
      messages: baseMessages,
      currentMessage,
      forceWebSearch,
    };

    const toolResponse =
      await this.toolRouterService.determineTool(toolRouterRequest);

    // If no tools needed, return unchanged context
    if (toolResponse.tools.length === 0) {
      return context;
    }

    // Execute web search if needed
    if (toolResponse.tools.includes('web_search')) {
      console.log(
        `[ToolRouterEnricher] Executing web search: "${toolResponse.searchQuery}"`,
      );

      try {
        // Find a model with agentId for search (prefer from context, fallback to any)
        const searchModel = context.model.agentId
          ? context.model
          : this.getAgentModelForSearch();

        if (!searchModel) {
          console.warn(
            '[ToolRouterEnricher] No agent model available for search, skipping',
          );
          return context;
        }

        const searchResult = await this.webSearchTool.execute({
          searchQuery: toolResponse.searchQuery || currentMessage,
          model: searchModel,
          user: context.user,
        });

        console.log(
          `[ToolRouterEnricher] Search completed: ${searchResult.text.length} chars, ${searchResult.citations?.length || 0} citations`,
        );
        console.log(
          '[ToolRouterEnricher] Search result citations detail:',
          JSON.stringify(searchResult.citations, null, 2),
        );

        // Get existing RAG citations to calculate correct numbering
        const existingCitations =
          context.processedContent?.metadata?.citations || [];
        const citationOffset = existingCitations.length;

        // Add search results as a system message before the last user message
        // Citation numbers must match the merged citation numbers (RAG first, then web)
        const citationReferences = searchResult.citations
          ? searchResult.citations
              .map(
                (c, idx) => `[${citationOffset + idx + 1}] ${c.title || c.url}`,
              )
              .join('\n')
          : '';

        const searchContextMessage: Message = {
          role: 'system',
          content: `Web Search results:\n\n${searchResult.text}\n\nAvailable sources:\n${citationReferences}\n\nIMPORTANT: When referencing these sources in your response, use citation markers in SEPARATE brackets like [1][2][3] - never group them like [1,2,3]. Do NOT include source information (URLs, titles, or dates) in your response text. The citation details will be displayed separately to the user.`,
          messageType: MessageType.TEXT,
        };

        // Insert search results before the last user message
        const enrichedMessages = [
          ...baseMessages.slice(0, -1),
          searchContextMessage,
          baseMessages[baseMessages.length - 1],
        ];
        const newCitations = searchResult.citations || [];

        const mergedCitations = [
          ...existingCitations,
          ...newCitations.map((c, idx) => ({
            ...c,
            number: existingCitations.length + idx + 1,
          })),
        ];

        console.log(
          '[ToolRouterEnricher] Merging citations - existing:',
          existingCitations.length,
          'new:',
          newCitations.length,
          'total:',
          mergedCitations.length,
        );

        return {
          ...context,
          enrichedMessages,
          processedContent: {
            ...context.processedContent,
            metadata: {
              ...context.processedContent?.metadata,
              citations: mergedCitations,
            },
          },
        };
      } catch (error) {
        console.error('[ToolRouterEnricher] Web search failed:', error);
        // Continue without search results on error
        return context;
      }
    }

    return context;
  }

  /**
   * Extracts text from complex message content.
   */
  private extractTextFromContent(content: any): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textContent = content.find((c) => c.type === 'text');
      return textContent?.text || '[non-text content]';
    }

    if (content && typeof content === 'object' && 'text' in content) {
      return content.text;
    }

    return '[complex content]';
  }

  /**
   * Gets a model with agentId for search (fallback if context model doesn't have one).
   * Uses GPT-4.1 as the default search agent.
   */
  private getAgentModelForSearch(): any {
    const defaultSearchModel = OpenAIModels[OpenAIModelID.GPT_4_1];

    if (!defaultSearchModel || !defaultSearchModel.agentId) {
      console.warn(
        '[ToolRouterEnricher] Default search agent (GPT-4.1) not available or missing agentId',
      );
      return null;
    }

    console.log(
      `[ToolRouterEnricher] Using default search agent: ${defaultSearchModel.name} (${defaultSearchModel.agentId})`,
    );
    return defaultSearchModel;
  }
}
