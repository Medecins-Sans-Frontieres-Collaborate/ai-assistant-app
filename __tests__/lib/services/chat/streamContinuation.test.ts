import {
  KEEP_RECENT,
  shrinkMessagesForOverflow,
  shrinkTranscriptForOverflow,
} from '@/lib/services/chat/contextOverflowRecovery';
import {
  ContinuationBudget,
  MAX_INTERRUPTION_RESUMES,
  MAX_OUTPUT_LIMIT_CONTINUATIONS,
  midStreamFailureMessage,
  normalizeAnthropicStop,
  normalizeOpenAIFinish,
  normalizeResponsesIncomplete,
} from '@/lib/services/chat/streamContinuation';

import { describe, expect, it } from 'vitest';

describe('finish normalisation', () => {
  it('maps each provider vocabulary onto one RoundFinish', () => {
    expect(normalizeOpenAIFinish('length')).toBe('length');
    expect(normalizeOpenAIFinish('content_filter')).toBe('content_filter');
    expect(normalizeOpenAIFinish('tool_calls')).toBe('tool_calls');
    expect(normalizeOpenAIFinish(null)).toBeNull();
    expect(normalizeAnthropicStop('max_tokens')).toBe('length');
    expect(normalizeAnthropicStop('refusal')).toBe('content_filter');
    expect(normalizeAnthropicStop('tool_use')).toBe('tool_calls');
    expect(normalizeAnthropicStop('pause_turn')).toBe('other');
    expect(normalizeResponsesIncomplete('max_output_tokens')).toBe('length');
    expect(normalizeResponsesIncomplete('content_filter')).toBe(
      'content_filter',
    );
  });
});

describe('ContinuationBudget', () => {
  it('caps interruptions and output-limit continuations independently', () => {
    const budget = new ContinuationBudget();
    for (let i = 0; i < MAX_INTERRUPTION_RESUMES; i += 1)
      expect(budget.take('interrupted')).toBe(true);
    expect(budget.take('interrupted')).toBe(false);
    for (let i = 0; i < MAX_OUTPUT_LIMIT_CONTINUATIONS; i += 1)
      expect(budget.take('length')).toBe(true);
    expect(budget.take('length')).toBe(false);
    expect(budget.used).toEqual({
      interruptions: MAX_INTERRUPTION_RESUMES,
      outputLimits: MAX_OUTPUT_LIMIT_CONTINUATIONS,
    });
  });
});

describe('midStreamFailureMessage', () => {
  it('explains a specific cause only when nothing was shown yet', () => {
    expect(midStreamFailureMessage('rate_limit', false)).toMatch(/requests/i);
    expect(midStreamFailureMessage('rate_limit', true)).toMatch(
      /stopped responding/,
    );
    expect(midStreamFailureMessage('unknown', false)).toMatch(
      /stopped responding/,
    );
  });
});

describe('context overflow recovery', () => {
  const msg = (role: string, i: number) => ({ role, content: `m${i}` });

  it('drops the oldest half of the droppable history, keeping system + recent', () => {
    const messages = [
      msg('system', 0),
      ...Array.from({ length: 9 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', i + 1),
      ),
    ];
    const shrunk = shrinkMessagesForOverflow(messages);
    expect(shrunk).not.toBeNull();
    expect(shrunk![0].role).toBe('system');
    // 9 non-system, 3 kept → 6 droppable → 3 dropped.
    expect(shrunk).toHaveLength(messages.length - 3);
    expect(shrunk!.slice(-KEEP_RECENT)).toEqual(messages.slice(-KEEP_RECENT));
  });

  it('returns null once only the protected tail is left', () => {
    expect(
      shrinkMessagesForOverflow([
        msg('system', 0),
        msg('user', 1),
        msg('assistant', 2),
        msg('user', 3),
      ]),
    ).toBeNull();
  });

  it('never drops the current turn in a tool-loop transcript', () => {
    const transcript = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'old q' },
      { role: 'assistant', content: 'old a' },
      { role: 'user', content: 'older q2' },
      { role: 'assistant', content: 'older a2' },
      { role: 'user', content: 'current question' },
      { role: 'assistant', content: 'calls a tool' },
      { role: 'tool', content: 'result' },
    ];
    const shrunk = shrinkTranscriptForOverflow(
      transcript,
      (m) => m.role === 'user',
    );
    expect(shrunk).not.toBeNull();
    expect(shrunk!.slice(-3)).toEqual(transcript.slice(-3));
    expect(shrunk![0].role).toBe('system');
    expect(shrunk).toHaveLength(transcript.length - 2);
    // Nothing older than the anchor left → null.
    expect(
      shrinkTranscriptForOverflow(
        transcript.slice(5),
        (m) => m.role === 'user',
      ),
    ).toBeNull();
  });
});
