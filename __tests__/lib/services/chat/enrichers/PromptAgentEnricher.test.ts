/**
 * Unit Tests for PromptAgentEnricher
 *
 * Tests the enricher that applies an app-defined prompt-agent persona
 * (docs/AGENT_ACCESS_CONTROL.md): system-prompt override + re-appended
 * conversation-context sections. No RAG search, no message enrichment.
 */
import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import { PromptAgentEnricher } from '@/lib/services/chat/enrichers/PromptAgentEnricher';
import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';

import { describe, expect, it } from 'vitest';

const promptAgentRecord = {
  version: 1 as const,
  id: 'prompt-abc123def456',
  name: 'Persona',
  description: 'A test persona',
  systemPrompt: 'You are a persona.',
  modelId: 'gpt-5.2',
  createdBy: 'admin@msf.org',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedBy: 'admin@msf.org',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

function makeContext(
  overrides: Partial<ChatContext> = {},
  withAgent = true,
): ChatContext {
  const context = createTestChatContext({
    botId: promptAgentRecord.id,
    systemPrompt: 'Original system prompt',
  });
  if (withAgent) {
    context.promptAgent = promptAgentRecord;
  }
  return { ...context, ...overrides };
}

describe('PromptAgentEnricher', () => {
  const enricher = new PromptAgentEnricher();

  describe('shouldRun', () => {
    it('returns true when a prompt agent was resolved', () => {
      expect(enricher.shouldRun(makeContext())).toBe(true);
    });

    it('returns false without a resolved prompt agent (even with botId)', () => {
      expect(enricher.shouldRun(makeContext({}, false))).toBe(false);
    });
  });

  describe('executeStage', () => {
    it('overrides the system prompt with the persona prompt', async () => {
      const result = await enricher.execute(makeContext());

      // Persona instructions come FIRST and verbatim; the shared rules follow
      expect(result.systemPrompt).toMatch(/^You are a persona\.\n\n/);
      expect(result.errors).toHaveLength(0);
    });

    it('re-appends the renderer-contract formatting rules (issue #121)', async () => {
      const result = await enricher.execute(makeContext());

      // Without this the persona replaces the base prompt wholesale and the
      // model defaults to \( \) / \[ \], which the app renders as raw LaTeX.
      expect(result.systemPrompt).toContain('## Response Formatting');
      expect(result.systemPrompt).toContain(
        '### Mathematical Notation / Formulas',
      );
      expect(result.systemPrompt).toContain('## Diagrams');
      expect(result.systemPrompt).toContain('$$');
    });

    it('falls back to the base prompt when the persona prompt is empty', async () => {
      const result = await enricher.execute(
        makeContext({
          promptAgent: { ...promptAgentRecord, systemPrompt: '' },
        }),
      );

      expect(result.systemPrompt).toBe('Original system prompt');
    });

    it('re-appends the conversation-context sections (summary + memories)', async () => {
      const result = await enricher.execute(
        makeContext({
          conversationSummary: 'We discussed budgets.',
          memories: ['Prefers concise answers'],
        }),
      );

      expect(result.systemPrompt).toMatch(/^You are a persona\.\n\n/);
      expect(result.systemPrompt).toContain('## Earlier Conversation Summary');
      expect(result.systemPrompt).toContain('We discussed budgets.');
      expect(result.systemPrompt).toContain('## User Memories');
      expect(result.systemPrompt).toContain('- Prefers concise answers');
    });

    it('leaves messages and processed content untouched (no RAG, no enrichment)', async () => {
      const context = makeContext();
      const result = await enricher.execute(context);

      expect(result.messages).toBe(context.messages);
      expect(result.enrichedMessages).toBeUndefined();
      expect(result.processedContent).toBe(context.processedContent);
    });
  });
});
