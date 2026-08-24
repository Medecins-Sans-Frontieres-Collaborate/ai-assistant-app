/**
 * Scaffolded: baseline prompt + an explicit answer-construction checklist
 * appended for the small model. Hypothesis: small models under-plan; telling
 * them *how* to assemble the answer (identify intent → list facts needed →
 * draft → check rules) recovers structure without a second call.
 */
import type { Strategy } from '../lib/types';
import { appSystemPrompt } from './baseline';

const SCAFFOLD = `

# Answer construction (follow silently, do not show these steps)
1. Restate the user's real intent to yourself in one line, including anything implied by earlier turns.
2. List the facts or steps the answer needs. If one is unknown, say so rather than guessing.
3. Choose the format: short question → short paragraph; procedure → numbered steps; comparison → table.
4. Draft the answer. Then check: did you answer exactly what was asked, nothing extra? Is every claim true? Is the Markdown valid?
5. Output only the final answer.`;

export const scaffolded: Strategy = {
  id: 'scaffolded',
  description: 'Baseline prompt + hidden answer-construction checklist.',
  async respond(ctx) {
    const res = await ctx.invoke({
      systemPrompt: appSystemPrompt(ctx) + SCAFFOLD,
      messages: [...ctx.history, { role: 'user', content: ctx.userMessage }],
    });
    return res.text;
  },
};
