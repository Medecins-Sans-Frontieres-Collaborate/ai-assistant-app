import { buildAgentPromptSections } from '@/lib/utils/app/systemPrompt';
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
 *   re-appending the shared formatting/diagram rules and conversation-context
 *   sections exactly like RAGEnricher's org-agent override, so the renderer
 *   contract and compaction summaries/memories survive the swap)
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

    // The persona's prompt REPLACES the base prompt, taking the renderer
    // contract (math/markdown/diagram rules) and the summary/memories
    // sections with it. Re-append both (mirrors RAGEnricher).
    //
    // Ordering is deliberate: the persona's own instructions come FIRST and
    // the shared rules after, so a persona that deliberately overrides
    // formatting still wins on substance — later text is what the model
    // treats as the more specific refinement, and the rules here describe
    // what the renderer can display rather than dictating content.
    const agentSections = buildAgentPromptSections(
      context.conversationSummary,
      context.memories,
    );

    return {
      ...context,
      // An empty persona prompt (legacy blob records bypass the schema's
      // min(1)) would otherwise ship a system prompt with no persona AND no
      // base behaviors; fall back to the full base prompt instead.
      systemPrompt: agent.systemPrompt
        ? `${agent.systemPrompt}\n\n${agentSections}`
        : context.systemPrompt,
    };
  }
}
