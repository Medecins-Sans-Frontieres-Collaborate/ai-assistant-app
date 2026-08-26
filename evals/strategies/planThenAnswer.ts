/**
 * Plan-then-answer (agentic, 2 calls): a cheap planning call produces a brief
 * outline, then the answer call is conditioned on it. This is the canonical
 * "more calls ≠ free" strategy — the harness counts both calls, so it has to
 * beat baseline on parity *and* stay under the cost ceiling to be worth it.
 */
import type { Strategy } from '../lib/types';
import { appSystemPrompt } from './baseline';

export const planThenAnswer: Strategy = {
  id: 'plan-then-answer',
  description:
    'Two calls: short plan (low effort, capped) → answer conditioned on the plan.',
  async respond(ctx) {
    const messages = [
      ...ctx.history,
      { role: 'user' as const, content: ctx.userMessage },
    ];
    const plan = await ctx.invoke({
      purpose: 'plan',
      systemPrompt:
        'You plan answers for another assistant. Output a terse bullet outline (max 6 bullets) of what the reply must cover, the best Markdown format, and any pitfalls. No prose.',
      messages,
      maxTokens: 300,
      reasoningEffort: 'low',
    });
    const answer = await ctx.invoke({
      purpose: 'answer',
      systemPrompt:
        appSystemPrompt(ctx) +
        `\n\n# Internal plan for this reply (do not show it)\n${plan.text}`,
      messages,
    });
    return answer.text;
  },
};
