import { Message, ToolRouterRequest } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AgentChatService } from '../AgentChatService';
import { ToolRouterService } from '../ToolRouterService';
import { ChatContext, shouldExecuteAsAgent } from '../pipeline/ChatContext';
import { STAGE_TIMEOUTS } from '../pipeline/ChatPipeline';
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

  // Derived to sit just under this stage's pipeline budget so a slow search
  // degrades via the catch below instead of being killed silently by the stage
  // timeout. Tied to STAGE_TIMEOUTS so the two can't drift apart.
  private static readonly SEARCH_TIMEOUT_MS =
    STAGE_TIMEOUTS.ToolRouterEnricher - 5000;

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
    // Capture the raw user prompt before file/transcript context gets
    // merged in below. The router LLM benefits from seeing the enriched
    // context, but a literal web search query should be just what the user
    // typed — pasting a 50-page document as the search query bloats input
    // tokens and confuses the search backend.
    const rawUserPrompt = currentMessage;

    // IMPORTANT: Include processed file summaries and transcripts in the analysis
    // This ensures the tool router can see the full context when deciding if web search is needed
    if (context.processedContent) {
      const additionalContext: string[] = [];

      // Add file summaries
      if (context.processedContent.fileSummaries) {
        const summaries = context.processedContent.fileSummaries
          .map((f) => `[Document summary: ${f.filename}]\n${f.summary}`)
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

    // Skip routing when the chat is going to run as a Foundry agent —
    // agents have their own `web_search_call` tool and decide for themselves
    // when to use it. Pre-routing duplicates work and adds ~5s of latency
    // per request. Predicate is shared with AgentEnricher to prevent the
    // two enrichers from drifting apart.
    const forceWebSearch = context.searchMode === SearchMode.ALWAYS;
    if (shouldExecuteAsAgent(context) && !forceWebSearch) {
      console.log(
        '[ToolRouterEnricher] Skipping pre-routing — agent will decide via its own tools',
      );
      return context;
    }

    // When the user explicitly chose ALWAYS search (SearchMode.ALWAYS), we
    // already know the decision — skip the gpt-5.4-nano router call (saves
    // ~1-2s of latency on every forced search). Synthesize a minimal
    // response that satisfies the downstream "execute web_search" branch.
    let toolResponse;
    if (forceWebSearch) {
      console.log(
        '[ToolRouterEnricher] forceWebSearch=true; skipping router decision',
      );
      toolResponse = {
        tools: ['web_search' as const],
        // Use the raw user prompt (no merged file/transcript context) so
        // the search backend gets a clean query. The search tool's own
        // model can refine it further if needed.
        searchQuery: rawUserPrompt,
      };
    } else {
      // Determine which tools are needed via the mini-model router.
      const toolRouterRequest: ToolRouterRequest = {
        messages: baseMessages,
        currentMessage,
        forceWebSearch,
      };
      toolResponse =
        await this.toolRouterService.determineTool(toolRouterRequest);
    }

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

        // Tell the client what we're doing — web search round-trips through
        // a Foundry agent and can take several seconds.
        await context.emitActivity?.('chat.activity.searchingWeb');

        let searchTimer: ReturnType<typeof setTimeout> | undefined;
        const searchResult = await Promise.race([
          this.webSearchTool.execute({
            searchQuery: toolResponse.searchQuery || currentMessage,
            model: searchModel,
            user: context.user,
          }),
          new Promise<never>((_, reject) => {
            searchTimer = setTimeout(() => {
              const err = new Error('Web search timed out');
              (err as { isSearchTimeout?: boolean }).isSearchTimeout = true;
              reject(err);
            }, ToolRouterEnricher.SEARCH_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (searchTimer) clearTimeout(searchTimer);
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

        // Cap search result text + citation count before synthesis. Without
        // this, a long search summary (10KB+) and a citations array of 20+
        // entries balloon the input prompt — slower synthesis, more cost,
        // and harder for the model to attend to the actual user question.
        // The agent's own search tool already summarises; this is a final
        // guard. Numbers are conservative: 8KB of text + 8 citations is
        // plenty for a typical question while preventing pathological
        // cases.
        const MAX_SEARCH_TEXT_CHARS = 8000;
        const MAX_SEARCH_CITATIONS = 8;
        const rawSearchText =
          searchResult.text.length > MAX_SEARCH_TEXT_CHARS
            ? searchResult.text.slice(0, MAX_SEARCH_TEXT_CHARS) +
              '\n\n[…search results truncated for length]'
            : searchResult.text;
        const truncatedCitations = (searchResult.citations ?? []).slice(
          0,
          MAX_SEARCH_CITATIONS,
        );
        // Strip orphaned citation references from the search text when the
        // citations array was truncated. Without this, the model can see
        // "[12]" in the body but only have [1]–[8] available in the source
        // list — it then hallucinates or attributes content to a citation
        // we dropped. Walk every [N] reference in the text and rewrite
        // anything past MAX_SEARCH_CITATIONS to remove the bracket entirely
        // (the surrounding sentence still reads correctly without it).
        const truncatedSearchText =
          (searchResult.citations?.length ?? 0) > MAX_SEARCH_CITATIONS
            ? rawSearchText.replace(/\[(\d+)\]/g, (match, n) =>
                Number(n) > MAX_SEARCH_CITATIONS ? '' : match,
              )
            : rawSearchText;

        // Build search context to prepend to the last user message
        // We merge search results INTO the user message instead of using a separate
        // system message, because Anthropic's API only supports 'user' and 'assistant'
        // roles — system messages are stripped by the Anthropic handler.
        // Citation numbers must match the merged citation numbers (RAG first, then web)
        const citationReferences = truncatedCitations.length
          ? truncatedCitations
              .map(
                (c, idx) => `[${citationOffset + idx + 1}] ${c.title || c.url}`,
              )
              .join('\n')
          : '';

        const searchContext = `Web Search results:\n\n${truncatedSearchText}\n\nAvailable sources:\n${citationReferences}\n\nIMPORTANT: When referencing these sources in your response, use citation markers in SEPARATE brackets like [1][2][3] - never group them like [1,2,3]. Do NOT include source information (URLs, titles, or dates) in your response text. The citation details will be displayed separately to the user.`;

        // Merge search context into the last user message so it works with ALL
        // model providers (OpenAI, Anthropic, DeepSeek, Llama, etc.)
        const lastMsg = baseMessages[baseMessages.length - 1];
        const enrichedLastMessage = this.prependContextToMessage(
          lastMsg,
          searchContext,
        );

        const enrichedMessages = [
          ...baseMessages.slice(0, -1),
          enrichedLastMessage,
        ];
        // Use the truncated citation list so the UI citations match the
        // numbered references in `citationReferences` above. Extra citations
        // (beyond the truncation cap) won't have numbered references in the
        // prompt and would render as orphans.
        const newCitations = truncatedCitations;

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
        const timedOut =
          (error as { isSearchTimeout?: boolean })?.isSearchTimeout === true;
        console.error(
          `[ToolRouterEnricher] Web search ${timedOut ? 'timed out' : 'failed'}:`,
          error,
        );
        // Still answer, but tell the model the search didn't return.
        const failureNotice =
          `Note: a web search was attempted to answer this but it ${timedOut ? 'timed out' : 'failed'}, so no live results are available. ` +
          `Answer from your own knowledge and clearly tell the user you could not retrieve up-to-date web results, ` +
          `so anything time-sensitive may be out of date.`;

        const lastMsg = baseMessages[baseMessages.length - 1];
        const enrichedLastMessage = this.prependContextToMessage(
          lastMsg,
          failureNotice,
        );

        return {
          ...context,
          enrichedMessages: [...baseMessages.slice(0, -1), enrichedLastMessage],
        };
      }
    }

    return context;
  }

  /**
   * Prepends context text to a message's content.
   * Handles both string and array content formats.
   */
  private prependContextToMessage(message: Message, context: string): Message {
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: `${context}\n\n---\n\n${message.content}`,
      };
    }

    if (Array.isArray(message.content)) {
      // Prepend to the first text block only
      const hasText = message.content.some((c) => c.type === 'text');
      if (hasText) {
        let modified = false;
        const modifiedContent = message.content.map((c) => {
          if (!modified && c.type === 'text' && 'text' in c) {
            modified = true;
            return { ...c, text: `${context}\n\n---\n\n${c.text}` };
          }
          return c;
        });
        return { ...message, content: modifiedContent };
      }

      // No text content, add as first item
      return {
        ...message,
        content: [{ type: 'text', text: context }, ...message.content],
      };
    }

    // Fallback: convert to string
    return {
      ...message,
      content: `${context}\n\n---\n\n${String(message.content)}`,
    };
  }

  /**
   * Extracts text from complex message content.
   */
  private extractTextFromContent(content: Message['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textContent = content.find((c) => c.type === 'text');
      return textContent && 'text' in textContent
        ? textContent.text
        : '[non-text content]';
    }

    return content.text;
  }

  /**
   * Gets a model with agentId for search (fallback if context model doesn't have one).
   * Uses GPT-5.2 (agent name 'gpt-52') as the default search agent.
   */
  private getAgentModelForSearch(): OpenAIModel | null {
    const defaultSearchModel = OpenAIModels[OpenAIModelID.GPT_5_2];

    if (!defaultSearchModel || !defaultSearchModel.agentId) {
      console.warn(
        '[ToolRouterEnricher] Default search agent (GPT-5.2) not available or missing agentId',
      );
      return null;
    }

    console.log(
      `[ToolRouterEnricher] Using default search agent: ${defaultSearchModel.name} (${defaultSearchModel.agentId})`,
    );
    return defaultSearchModel;
  }
}
