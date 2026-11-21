import { STORED_SOURCE_TEXT_MIN_CHARS } from '@/lib/utils/shared/translation/storedSourceText';
import { sourceTextFingerprint } from '@/lib/utils/shared/translation/storedSourceText';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * What reaches localStorage for a translation whose source text is in
 * storage, and what comes back from it.
 */
const TEXT = 'Paragraphe du rapport. '.repeat(
  Math.ceil(STORED_SOURCE_TEXT_MIN_CHARS / 23) + 10,
);
const REF = {
  id: '11111111-2222-4333-8444-555555555555',
  backend: 'app' as const,
  fingerprint: sourceTextFingerprint(TEXT),
};

/**
 * Puts a conversation in the store. The browser's copy is rewritten only
 * when `updatedAt` changes, as every real edit makes it.
 */
function seed(
  state: Partial<TranslationWorkflowState>,
  updatedAt = '2026-11-18T10:00:00.000Z',
) {
  const conversation = {
    id: 'c1',
    name: 'Translation',
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.5,
    folderId: null,
    conversationType: 'translation',
    updatedAt,
    workflowState: {
      kind: 'translation',
      sourceText: TEXT,
      mode: 'quick',
      rounds: [],
      finalText: 'Report paragraph.',
      updatedAt: '2026-11-18T10:00:00.000Z',
      ...state,
    },
  } as unknown as Conversation;
  useConversationStore.setState({ conversations: [conversation] });
}

const inMemory = () =>
  useConversationStore.getState().conversations[0]
    .workflowState as TranslationWorkflowState;
const inBrowser = () =>
  JSON.parse(localStorage.getItem('conv-data-c1') ?? 'null')?.workflowState as
    | TranslationWorkflowState
    | undefined;

beforeEach(() => {
  localStorage.clear();
  useConversationStore.setState({ conversations: [] });
});

describe('a translation with its source text in storage', () => {
  it('is written to the browser without the text, and keeps it in memory', () => {
    seed({ sourceTextRef: REF });
    expect(inBrowser()?.sourceText).toBe('');
    expect(inBrowser()?.sourceTextRef).toEqual({ ...REF, detached: true });
    expect(inBrowser()?.finalText).toBe('Report paragraph.');
    expect(localStorage.getItem('conv-data-c1')!.length).toBeLessThan(2000);
    expect(inMemory().sourceText).toBe(TEXT);
    expect(inMemory().sourceTextRef?.detached).toBeUndefined();
  });

  it('is written in full while storage does not hold the current text', () => {
    seed({});
    expect(inBrowser()?.sourceText).toBe(TEXT);
    seed(
      { sourceText: `${TEXT} edited`, sourceTextRef: REF },
      '2026-11-18T10:05:00.000Z',
    );
    expect(inBrowser()?.sourceText).toBe(`${TEXT} edited`);
  });

  it('comes back from the browser asking for its text', async () => {
    seed({ sourceTextRef: REF });
    const written = localStorage.getItem('conv-data-c1');
    await useConversationStore.persist.rehydrate();
    expect(localStorage.getItem('conv-data-c1')).toBe(written);
    expect(inMemory().sourceText).toBe('');
    expect(inMemory().sourceTextRef).toEqual({ ...REF, detached: true });
  });

  it('takes a fetched text without counting as an edit', () => {
    seed({ sourceText: '', sourceTextRef: { ...REF, detached: true } });
    const before = useConversationStore.getState().conversations[0].updatedAt;
    useConversationStore.getState().hydrateWorkflowState('c1', (state) => ({
      ...(state as TranslationWorkflowState),
      sourceText: TEXT,
      sourceTextRef: REF,
    }));
    expect(inMemory().sourceText).toBe(TEXT);
    expect(useConversationStore.getState().conversations[0].updatedAt).toBe(
      before,
    );
    // Still not in the browser.
    expect(inBrowser()?.sourceText).toBe('');
  });
});
