import { buildConversationContextSections } from '@/lib/utils/app/systemPrompt';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

/**
 * PromptAgentEnricher applies an app-defined prompt-agent persona
 * (docs/AGENT_ACCESS_CONTROL.md) to the request.
 *
 * The persona record is resolved server-side by
 * createModelSelectionMiddleware (which also swaps in the admin-chosen
 * model); this stage only overrides the system prompt with the persona's
 * prompt. No RAG search, no web-search changes — prompt agents ride the
 * standard execution path.
 *
 * Modifies context:
 * - context.systemPrompt (overridden with the prompt agent's system prompt,
 *   re-appending the conversation-context sections exactly like RAGEnricher's
 *   org-agent override so compaction summaries/memories survive the swap)
 */
export class PromptAgentEnricher extends BasePipelineStage {
  readonly name = 'PromptAgentEnricher';

  shouldRun(context: ChatContext): boolean {
    return !!context.promptAgent;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const agent = context.promptAgent;
    if (!agent) return context;

    console.log(
      `[PromptAgentEnricher] Applying prompt agent persona: ${sanitizeForLog(agent.id)}`,
    );

    // Summary/memories sections already live in context.systemPrompt
    // (buildSystemPrompt); re-append them when the persona's prompt replaces
    // it so the request keeps the sections (mirrors RAGEnricher).
    const conversationContext = buildConversationContextSections(
      context.conversationSummary,
      context.memories,
    );

    return {
      ...context,
      systemPrompt: conversationContext
        ? `${agent.systemPrompt}\n\n${conversationContext}`
        : agent.systemPrompt,
    };
  }
}
