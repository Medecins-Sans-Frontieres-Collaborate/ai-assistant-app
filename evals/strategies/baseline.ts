/**
 * Baseline: exactly what the app sends today — buildSystemPrompt() from
 * lib/utils/app/systemPrompt.ts with the case's prompt options. This is the
 * goal model's default strategy and the control for the aspirational model.
 */
import { buildSystemPrompt } from '@/lib/utils/app/systemPrompt';

import type { Strategy, StrategyContext } from '../lib/types';

export function appSystemPrompt(ctx: StrategyContext): string {
  return buildSystemPrompt({
    currentDateTime: new Date('2026-08-21T09:00:00Z'), // pinned so cache keys are stable
    ...ctx.eval.promptOptions,
  });
}

export const baseline: Strategy = {
  id: 'baseline',
  description: 'Unmodified app system prompt (control).',
  async respond(ctx) {
    const res = await ctx.invoke({
      systemPrompt: appSystemPrompt(ctx),
      messages: [...ctx.history, { role: 'user', content: ctx.userMessage }],
    });
    return res.text;
  },
};
