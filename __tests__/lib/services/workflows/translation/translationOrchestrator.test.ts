import type { WorkflowStreamWriter } from '@/lib/services/workflows/shared/workflowLlm';
import {
  MAX_REVIEW_ROUNDS,
  runTranslationWorkflow,
} from '@/lib/services/workflows/translation/translationOrchestrator';

import { WorkflowEventPayload } from '@/lib/streamMarkers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The orchestrator is exercised with the LLM layer mocked out: structured
 * calls return canned analysis/review payloads, the streamed translate
 * call emits a fixed translation.
 */
const callStructured = vi.fn();
const callStreamedText = vi.fn();

vi.mock(
  '@/lib/services/workflows/shared/workflowLlm',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/lib/services/workflows/shared/workflowLlm')
      >();
    return {
      ...original,
      createAzureClient: () => ({}),
      callStructured: (...args: unknown[]) => callStructured(...args),
      callStreamedText: (...args: unknown[]) => callStreamedText(...args),
    };
  },
);

const ANALYSIS = {
  trickyTerms: [],
  ambiguities: [],
  register: 'formal',
  notes: '',
};

function makeWriter() {
  const events: WorkflowEventPayload[] = [];
  const texts: string[] = [];
  const writer: WorkflowStreamWriter = {
    activity: vi.fn(),
    event: (payload) => events.push(payload),
    text: (delta) => texts.push(delta),
    close: vi.fn(),
    fail: vi.fn(),
  };
  return { writer, events, texts };
}

function reviewResult(verdict: 'approve' | 'revise', text: string) {
  return {
    verdict,
    issues:
      verdict === 'revise'
        ? [
            {
              excerpt: 'x',
              problem: 'wrong term',
              severity: 'major',
              suggestion: 'use y',
            },
          ]
        : [],
    revisedText: text,
  };
}

describe('runTranslationWorkflow', () => {
  beforeEach(() => {
    callStructured.mockReset();
    callStreamedText.mockReset();
    callStreamedText.mockImplementation(async (opts: any) => {
      opts.onDelta('Bonjour');
      return 'Bonjour';
    });
  });

  it('quick mode skips analysis and review', async () => {
    const { writer, events } = makeWriter();
    await runTranslationWorkflow({
      sourceText: 'Hello',
      targetLanguage: 'French',
      glossaryEntries: [],
      mode: 'quick',
      writer,
    });

    expect(callStructured).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['complete']);
    expect(events[0].data).toMatchObject({ finalText: 'Bonjour', rounds: 0 });
  });

  it('agentic mode stops early on approve', async () => {
    callStructured
      .mockResolvedValueOnce(ANALYSIS) // analysis phase
      .mockResolvedValueOnce(reviewResult('approve', 'Bonjour'));

    const { writer, events } = makeWriter();
    await runTranslationWorkflow({
      sourceText: 'Hello',
      targetLanguage: 'French',
      glossaryEntries: [],
      mode: 'agentic',
      writer,
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual(['analysis', 'review_round', 'complete']);
    expect(events[2].data).toMatchObject({ rounds: 1 });
  });

  it('agentic mode is bounded at MAX_REVIEW_ROUNDS even when never approved', async () => {
    callStructured.mockImplementation(async (opts: any) => {
      if (opts.schemaName === 'translation_analysis') return ANALYSIS;
      return reviewResult('revise', 'Bonjour (revisé)');
    });

    const { writer, events } = makeWriter();
    await runTranslationWorkflow({
      sourceText: 'Hello',
      targetLanguage: 'French',
      glossaryEntries: [],
      mode: 'agentic',
      writer,
    });

    const reviewRounds = events.filter((e) => e.type === 'review_round');
    expect(reviewRounds).toHaveLength(MAX_REVIEW_ROUNDS);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.data).toMatchObject({
      finalText: 'Bonjour (revisé)',
      rounds: MAX_REVIEW_ROUNDS,
    });
  });

  it('caps a caller-supplied round budget at MAX_REVIEW_ROUNDS', async () => {
    callStructured.mockImplementation(async (opts: any) => {
      if (opts.schemaName === 'translation_analysis') return ANALYSIS;
      return reviewResult('revise', 'x');
    });

    const { writer, events } = makeWriter();
    await runTranslationWorkflow({
      sourceText: 'Hello',
      targetLanguage: 'French',
      glossaryEntries: [],
      mode: 'agentic',
      maxReviewRounds: 99,
      writer,
    });

    expect(events.filter((e) => e.type === 'review_round')).toHaveLength(
      MAX_REVIEW_ROUNDS,
    );
  });
});
