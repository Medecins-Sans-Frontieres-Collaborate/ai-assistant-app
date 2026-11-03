import {
  appliedSkillVersionsFromToolCalls,
  attachAppliedSkillVersions,
  mergeSkillRequestMetadata,
  requestedSkillsForMessage,
  skillSelectionForRequest,
  skillVersionsForRequest,
} from '@/lib/utils/shared/chat/skillSelection';

import type { ConversationEntry } from '@/types/chat';

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

describe('applied skill versions (regeneration replay)', () => {
  const record = {
    id: 'skills-1',
    name: 'use_skills',
    server_label: 'Skills',
    status: 'completed' as const,
    arguments: JSON.stringify({
      applied: [
        { id: 'gdpr', updatedAt: '2026-10-01T00:00:00.000Z' },
        { id: '../bad', updatedAt: 'x' },
        { id: 'forms', updatedAt: 7 },
      ],
    }),
    output: 'GDPR (requested)',
    error: null,
  };
  it('reads versions from the record and ignores malformed entries', () => {
    expect(appliedSkillVersionsFromToolCalls([record])).toEqual({
      gdpr: '2026-10-01T00:00:00.000Z',
    });
    expect(
      appliedSkillVersionsFromToolCalls([{ ...record, arguments: '{oops' }]),
    ).toBeUndefined();
    expect(appliedSkillVersionsFromToolCalls(undefined)).toBeUndefined();
  });
  it('attaches versions to the last user message before the regenerated index', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'a2' },
    ] as unknown as ConversationEntry[];
    const result = attachAppliedSkillVersions(messages, { gdpr: 'v' }, 1);
    expect(
      (result[0] as { appliedSkillVersions?: unknown }).appliedSkillVersions,
    ).toEqual({ gdpr: 'v' });
    expect('appliedSkillVersions' in result[2]).toBe(false);
    expect(attachAppliedSkillVersions(messages, undefined)).toBe(messages);
  });
  it('pins only on replay, only for ids still requested, never personal skills', () => {
    const saved = { gdpr: 'v1', 'user:mine': 'v2', forms: 'v3' };
    expect(skillVersionsForRequest(saved, ['gdpr', 'user:mine'], true)).toEqual(
      { gdpr: 'v1' },
    );
    expect(skillVersionsForRequest(saved, ['gdpr'], false)).toBeUndefined();
    expect(skillVersionsForRequest(saved, [], true)).toBeUndefined();
    expect(skillVersionsForRequest(undefined, ['gdpr'], true)).toBeUndefined();
  });
});
