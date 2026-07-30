/**
 * Retrieval stage for M365 file-backed agents
 * (docs/M365_SECOND_PASS_AGENTS_DESIGN.md) — the RAGEnricher shape over the
 * shared m365-agents index instead of the org index.
 *
 * The two-layer access guard has ALREADY run in the credential middleware by
 * the time this stage executes: `context.m365Agent` is only set for allowed
 * users, and `context.m365AccessibleSourceIds` holds the layer-2-verified
 * subset. This stage never widens either — retrieval is hard-filtered to
 * the accessible sources, so a user sees answers only from files their own
 * Graph token can open.
 *
 * Model orchestration per request: the chat model was resolved by
 * createModelSelectionMiddleware (agent's chatModelId or the catalog
 * default); the query is reformulated with the shared utility model and
 * embedded with the agent's embedding deployment inside searchM365Agent.
 */
import { searchM365Agent } from '@/lib/services/m365/agentIndexService';

import { buildConversationContextSections } from '@/lib/utils/app/systemPrompt';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message, MessageType } from '@/types/chat';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import OpenAI from 'openai';

const REFORMULATION_MODEL = 'gpt-5-mini';

export class M365AgentEnricher extends BasePipelineStage {
  readonly name = 'M365AgentEnricher';

  constructor(private openAIClient: OpenAI) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    return !!context.m365Agent;
  }

  /** Last user-message text; empty string when none (e.g. image-only). */
  private extractQuery(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      if (typeof message.content === 'string') return message.content;
      return '';
    }
    return '';
  }

  /**
   * Compact search-query reformulation with the shared utility model —
   * same role (and same deployment) as RAGService.reformulateQuery. Any
   * failure falls back to the raw query; retrieval quality degrades, the
   * request never does.
   */
  private async reformulateQuery(messages: Message[]): Promise<string> {
    const original = this.extractQuery(messages);
    if (!original) return original;
    try {
      const history = messages
        .slice(-5)
        .map(
          (m) =>
            `${m.role}: ${typeof m.content === 'string' ? m.content : '[non-text]'}`,
        )
        .join('\n');
      const completion = await this.openAIClient.chat.completions.create({
        model: REFORMULATION_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Rewrite the final user question as a concise, self-contained search query for a document knowledge base. Resolve pronouns and references using the conversation. Return ONLY the query.',
          },
          { role: 'user', content: `${history}\n\nSearch query:` },
        ],
      });
      return completion.choices[0]?.message?.content?.trim() || original;
    } catch {
      return original;
    }
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const agent = context.m365Agent;
    if (!agent) return context;
    const accessibleSourceIds = context.m365AccessibleSourceIds ?? [];
    if (accessibleSourceIds.length === 0) {
      // Middleware rejects zero-access requests; an empty list here means a
      // wiring regression. Fail safe: no retrieval, no content exposure.
      console.error(
        `[M365AgentEnricher] no accessible sources on context for ${sanitizeForLog(agent.id)}; skipping retrieval`,
      );
      return context;
    }

    await context.emitActivity?.('chat.activity.searchingKnowledge');

    const baseMessages = context.enrichedMessages || context.messages;
    let enrichedMessages: Message[] = [...baseMessages];

    try {
      const query = await this.reformulateQuery(context.messages);
      const searchDocs = query
        ? await searchM365Agent(query, agent, accessibleSourceIds)
        : [];

      if (searchDocs.length > 0) {
        const contextString = searchDocs
          .map((doc, index) => {
            const sourceNumber = index + 1;
            const date = doc.date
              ? new Date(doc.date).toISOString().split('T')[0]
              : '';
            return `Source ${sourceNumber}:\nTitle: ${doc.title}\nDate: ${date}\nURL: ${doc.url}\nContent: ${doc.chunk}`;
          })
          .join('\n\n');

        enrichedMessages = [
          {
            role: 'system',
            content: `You have access to the following knowledge base sources. When citing information, use source numbers in SEPARATE brackets like [1][2][3] - never group them like [1,2,3].\n\nAvailable sources:\n\n${contextString}`,
            messageType: MessageType.TEXT,
          },
          ...enrichedMessages,
        ];
      }

      const citations = searchDocs.map((doc, index) => ({
        title: doc.title,
        date: doc.date,
        url: doc.url,
        number: index + 1,
      }));

      const conversationContext = buildConversationContextSections(
        context.conversationSummary,
        context.memories,
      );

      return {
        ...context,
        enrichedMessages,
        systemPrompt:
          agent.systemPrompt && conversationContext
            ? `${agent.systemPrompt}\n\n${conversationContext}`
            : agent.systemPrompt || context.systemPrompt,
        processedContent: {
          ...context.processedContent,
          metadata: {
            ...context.processedContent?.metadata,
            citations,
            m365AgentConfig: {
              agentId: agent.id,
              agentName: agent.name,
              accessibleSources: accessibleSourceIds.length,
              totalSources: agent.sources.length,
              resultCount: searchDocs.length,
            },
          },
        },
      };
    } catch (error) {
      // Graceful degrade, exactly like RAGEnricher: the chat continues
      // without retrieval rather than failing the request.
      console.error(
        `[M365AgentEnricher] retrieval failed for ${sanitizeForLog(agent.id)}: ${sanitizeForLog(error)}`,
      );
      return context;
    }
  }
}
