import { composeExtractionPrompt } from '@/lib/utils/server/extraction/composeExtractionPrompt';
import { recipesToResponseFormat } from '@/lib/utils/server/extraction/recipeToJsonSchema';

import { Message, TextMessageContent } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { AgentChatService } from '../AgentChatService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import { WebSearchTool } from '../tools/WebSearchTool';

/**
 * Conservative URL regex (http/https only). Matches standalone URLs in
 * message text — anything subtler is handed off to the existing
 * `ToolRouterEnricher` upstream.
 */
const URL_REGEX = /\bhttps?:\/\/[^\s<>"']+/i;

/**
 * ExtractionEnricher
 *
 * Activates when the client sends an `extraction` payload (up to three
 * recipes, or auto mode). Three responsibilities:
 *
 * 1. **URL handoff** — if a URL appears in the user's last message, route
 *    it through the existing `WebSearchTool` so the fetched text becomes
 *    part of the model's context. Reuses the privacy-preserving / SSRF-
 *    hardened path already in place; no new fetch infra introduced.
 *
 * 2. **Prompt composition** — appends an extraction-specific addendum
 *    describing the recipes and the shared rules to `context.systemPrompt`.
 *
 * 3. **Response format** — builds a composite JSON Schema covering all
 *    selected recipes and writes it to `context.responseFormat`. The
 *    `StandardChatHandler` reads this and switches to a strict structured-
 *    output call.
 *
 * Pipeline placement: AFTER `ToolRouterEnricher` (so we can decide whether
 * to override the normal search routing for URLs) and BEFORE `AgentEnricher`
 * (so agent mode still wins if both are accidentally on).
 */
export class ExtractionEnricher extends BasePipelineStage {
  readonly name = 'ExtractionEnricher';

  private webSearchTool: WebSearchTool;

  constructor(agentChatService: AgentChatService) {
    super();
    this.webSearchTool = new WebSearchTool(agentChatService);
  }

  shouldRun(context: ChatContext): boolean {
    return !!context.extraction;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const extraction = context.extraction;
    if (!extraction) {
      return context;
    }

    let workingContext = context;

    // 1. URL handoff via WebSearchTool. Non-fatal on failure — we continue
    // and let the model work with whatever else is in the message.
    const baseMessages =
      workingContext.enrichedMessages || workingContext.messages;
    const lastMessage = baseMessages[baseMessages.length - 1];
    const lastText = this.extractTextFromContent(lastMessage?.content);
    const urlMatch = lastText.match(URL_REGEX);

    if (urlMatch && urlMatch[0] && lastMessage) {
      const url = urlMatch[0];
      console.log(
        `[ExtractionEnricher] URL detected, fetching via WebSearchTool: ${url}`,
      );

      try {
        const searchModel = workingContext.model.agentId
          ? workingContext.model
          : (OpenAIModels[OpenAIModelID.GPT_4_1] ?? workingContext.model);

        const searchResult = await this.webSearchTool.execute({
          searchQuery: url,
          model: searchModel,
          user: workingContext.user,
        });

        if (searchResult.text && searchResult.text.length > 0) {
          const fetchedBlock = `\n\n[Fetched from ${url}]\n${searchResult.text}`;
          const enrichedLast = this.appendTextToMessage(
            lastMessage,
            fetchedBlock,
          );

          workingContext = {
            ...workingContext,
            enrichedMessages: [...baseMessages.slice(0, -1), enrichedLast],
          };
        }
      } catch (error) {
        console.warn(
          '[ExtractionEnricher] URL fetch failed, continuing without:',
          error,
        );
      }
    }

    // Auto mode: the handler runs a two-stage propose-then-extract flow
    // (Stage 1 calls `proposeFlatSchema`, Stage 2 reuses recipe mode with
    // the synthesised recipe). Don't compose a prompt addendum or
    // response format here — the handler builds both with the real
    // recipe in hand.
    if (extraction.recipes.length === 0) {
      return workingContext;
    }

    // Recipe mode: compose the strict response format + prompt addendum
    // up front so the handler can call `handleExtraction` directly.
    const addendum = composeExtractionPrompt(extraction.recipes);
    const enrichedSystemPrompt = workingContext.systemPrompt
      ? `${workingContext.systemPrompt}\n\n${addendum}`
      : addendum;

    const composed = recipesToResponseFormat(extraction.recipes);

    return {
      ...workingContext,
      systemPrompt: enrichedSystemPrompt,
      responseFormat: {
        name: composed.name,
        schema: composed.schema,
        strict: composed.strict,
        recipeOrder: composed.recipeOrder,
        keyByRecipeId: composed.keyByRecipeId,
      },
    };
  }

  private extractTextFromContent(
    content: Message['content'] | undefined,
  ): string {
    if (content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text') {
          return c.text;
        }
      }
      return '';
    }
    if (content.type === 'text') {
      return content.text;
    }
    return '';
  }

  private appendTextToMessage(message: Message, text: string): Message {
    if (typeof message.content === 'string') {
      return { ...message, content: `${message.content}${text}` };
    }
    if (Array.isArray(message.content)) {
      let appended = false;
      const next = message.content.map((c) => {
        if (!appended && c.type === 'text') {
          appended = true;
          return { ...c, text: `${c.text}${text}` };
        }
        return c;
      });
      if (!appended) {
        const textBlock: TextMessageContent = { type: 'text', text };
        return {
          ...message,
          content: [...message.content, textBlock] as Message['content'],
        };
      }
      return { ...message, content: next as Message['content'] };
    }
    if (message.content.type === 'text') {
      return {
        ...message,
        content: { type: 'text', text: `${message.content.text}${text}` },
      };
    }
    return message;
  }
}
