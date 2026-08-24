/**
 * Compact: a much shorter base prompt that keeps only the rules small models
 * demonstrably drop (formatting, accuracy, refusal scope) and strips the
 * long-form rationale. Hypothesis: small models follow short, imperative
 * instruction lists better than long prose, and fewer prompt tokens cut cost.
 */
import {
  DEFAULT_USER_PROMPT,
  buildConversationContextSections,
} from '@/lib/utils/app/systemPrompt';

import type { Strategy, StrategyContext } from '../lib/types';

const COMPACT_BASE = `You are the MSF AI assistant.
Rules:
1. Be accurate. If unsure, say so and say what would resolve it. Never invent facts, citations, or numbers.
2. Answer the actual question first, then add only needed context.
3. Use Markdown: headings for long answers, bullet lists for options/steps, tables for comparisons, fenced code blocks for code.
4. Match the user's language and register.
5. Keep answers as short as the task allows. No filler, no restating the question.
6. For sensitive humanitarian/medical topics, be factual and neutral; do not moralise.`;

export function compactSystemPrompt(ctx: StrategyContext): string {
  const o = ctx.eval.promptOptions ?? {};
  const features: string[] = [];
  if (o.webSearchActive)
    features.push(
      '- Web search results may be provided; cite them inline as [n].',
    );
  if (o.codeInterpreterAvailable)
    features.push(
      '- You can run Python to compute or produce files; do so for calculations.',
    );
  const ctxSections = buildConversationContextSections(
    o.conversationSummary,
    o.memories,
  );
  return [
    COMPACT_BASE,
    features.length ? `Features:\n${features.join('\n')}` : '',
    ctxSections,
    `# User Instructions\n\n${o.userPrompt ?? DEFAULT_USER_PROMPT}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const compact: Strategy = {
  id: 'compact',
  description: 'Short imperative rule list instead of the long base prompt.',
  async respond(ctx) {
    const res = await ctx.invoke({
      systemPrompt: compactSystemPrompt(ctx),
      messages: [...ctx.history, { role: 'user', content: ctx.userMessage }],
    });
    return res.text;
  },
};
