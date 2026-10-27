import {
  mergeSkillRequestMetadata,
  requestedSkillsForMessage,
  skillSelectionForRequest,
} from '@/lib/utils/shared/chat/skillSelection';

import { describe, expect, it } from 'vitest';

describe('conversation skill request selection', () => {
  it('approval resumes replay saved choices without consuming a picker meant for the next question', () => {
    expect(
      requestedSkillsForMessage(['gdpr'], ['user:next-task'], true),
    ).toEqual(['gdpr']);
    expect(requestedSkillsForMessage(['gdpr'], ['user:next-task'])).toEqual([
      'user:next-task',
    ]);
  });
  it('replay metadata merging never appends later conversation history', () => {
    const question = {
      id: 'one',
      role: 'user' as const,
      content: 'First',
      messageType: undefined,
    };
    const later = {
      ...question,
      id: 'two',
      content: 'Later',
      requestedSkillIds: ['later'],
    };
    const merged = mergeSkillRequestMetadata(
      [question],
      [{ ...question, requestedSkillIds: ['gdpr'] }, later],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveProperty('requestedSkillIds', ['gdpr']);
  });
  it('keeps pins on subsequent turns after one-shot selections are consumed', () => {
    expect(skillSelectionForRequest(['gdpr'], ['weekly-report'])).toEqual({
      forcedSkillIds: ['gdpr', 'weekly-report'],
      pinnedSkillIds: ['gdpr'],
    });
    expect(skillSelectionForRequest(['gdpr'], [])).toEqual({
      forcedSkillIds: ['gdpr'],
      pinnedSkillIds: ['gdpr'],
    });
    expect(skillSelectionForRequest([], [])).toEqual({
      forcedSkillIds: undefined,
      pinnedSkillIds: undefined,
    });
  });
  it('dedupes and caps combined selections, preserving pin priority', () => {
    expect(
      skillSelectionForRequest(['a', 'a', 'b'], ['a', 'c', 'd']).forcedSkillIds,
    ).toEqual(['a', 'b', 'c']);
  });
  it('drops invalid imported ids and accepts old conversations without pins', () => {
    expect(
      skillSelectionForRequest(undefined, ['gdpr']).forcedSkillIds,
    ).toEqual(['gdpr']);
    expect(
      skillSelectionForRequest(['../bad', 'UPPER', 'gdpr'], undefined)
        .pinnedSkillIds,
    ).toEqual(['gdpr']);
  });
});
