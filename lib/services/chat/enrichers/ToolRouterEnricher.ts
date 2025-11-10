import { Message, MessageType, ToolRouterRequest } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AgentChatService } from '../AgentChatService';
import { ToolRouterService } from '../ToolRouterService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import { WebSearchTool } from '../tools/WebSearchTool';

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
    return (
      context.searchMode === SearchMode.INTELLIGENT ||
      context.searchMode === SearchMode.ALWAYS
    );
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    console.log(`[ToolRouterEnricher] Search mode: ${context.searchMode}`);

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
        console.log(
          `[ToolRouterEnricher] Including processed content: ${context.processedContent.fileSummaries?.length || 0} files, ${context.processedContent.transcripts?.length || 0} transcripts`,
        );
      }
    }

    console.log(
      `[ToolRouterEnricher] Analyzing message for tool needs: "${currentMessage.substring(0, 100)}..."`,
    );

    // Determine which tools are needed
    const forceWebSearch = context.searchMode === SearchMode.ALWAYS;
    const toolRouterRequest: ToolRouterRequest = {
      messages: baseMessages,
      currentMessage,
      forceWebSearch,
    };

    const toolResponse =
      await this.toolRouterService.determineTool(toolRouterRequest);

    console.log('[ToolRouterEnricher] Tool router response:', {
      tools: toolResponse.tools,
      reasoning: toolResponse.reasoning,
    });

    // If no tools needed, return unchanged context
    if (toolResponse.tools.length === 0) {
      console.log(
        '[ToolRouterEnricher] No tools needed, continuing without search',
      );
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

        // Add search results as a system message before the last user message
        const citationReferences = searchResult.citations
          ? searchResult.citations
              .map((c, idx) => `[${idx + 1}] ${c.title || c.url}`)
              .join('\n')
          : '';

        const searchContextMessage: Message = {
          role: 'system',
          content: `Web Search results:\n\n${searchResult.text}\n\nAvailable sources:\n${citationReferences}\n\nIMPORTANT: When referencing these sources in your response, use ONLY citation markers like [1], [2], etc. Do NOT include source information (URLs, titles, or dates) in your response text. The citation details will be displayed separately to the user.`,
          messageType: MessageType.TEXT,
        };

        // Insert search results before the last user message
        const enrichedMessages = [
          ...baseMessages.slice(0, -1),
          searchContextMessage,
          baseMessages[baseMessages.length - 1],
        ];

        // Store citations in metadata for later use
        return {
          ...context,
          enrichedMessages,
          processedContent: {
            ...context.processedContent,
            metadata: {
              ...context.processedContent?.metadata,
              citations: searchResult.citations,
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
