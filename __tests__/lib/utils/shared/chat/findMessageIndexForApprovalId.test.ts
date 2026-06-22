import { findMessageIndexForApprovalId } from '@/lib/utils/shared/chat/findMessageIndexForApprovalId';

import {
  ConsentRequest,
  Conversation,
  Message,
  MessageType,
} from '@/types/chat';

import { describe, expect, it } from 'vitest';

function makeConversation(
  entries: Array<{
    role: 'user' | 'assistant';
    content?: string;
    consentRequests?: ConsentRequest[];
  }>,
): Conversation {
  const messages: Message[] = entries.map(
    ({ role, content, consentRequests }) => ({
      role,
      content: content ?? '',
      messageType: MessageType.TEXT,
      consentRequests,
    }),
  );
  return {
    id: 'c1',
    name: 'test',
    messages,
    model: { id: 'gpt-5.2', name: 'gpt-5.2' } as any,
    prompt: '',
    temperature: 0.5,
    folderId: null,
  };
}

const approval = (id: string, toolName = 'do_thing'): ConsentRequest => ({
  kind: 'approval',
  approval_request_id: id,
  tool_name: toolName,
});

describe('findMessageIndexForApprovalId', () => {
  it('returns null when the approval id is empty', () => {
    const conv = makeConversation([
      { role: 'assistant', consentRequests: [approval('mcpr_1')] },
    ]);
    expect(findMessageIndexForApprovalId(conv, '')).toBeNull();
  });

  it('returns null when no message has a matching consent request', () => {
    const conv = makeConversation([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello back' },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_1')).toBeNull();
  });

  it('locates the assistant message with the matching consent request', () => {
    const conv = makeConversation([
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: 'sure thing',
        consentRequests: [approval('mcpr_target')],
      },
      { role: 'user', content: 'next message' },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_target')).toBe(1);
  });

  it('matches the structured field, not stray text in the body', () => {
    const conv = makeConversation([
      {
        role: 'assistant',
        content:
          "Just so you know, I'll be invoking approval id mcpr_phantom soon.",
      },
      {
        role: 'assistant',
        content: 'sure',
        consentRequests: [approval('mcpr_phantom')],
      },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_phantom')).toBe(1);
  });

  it('ignores oauth consent requests when looking up an approval id', () => {
    const conv = makeConversation([
      {
        role: 'assistant',
        consentRequests: [
          { kind: 'oauth', consent_url: 'https://example.com/auth' },
        ],
      },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_x')).toBeNull();
  });

  it('returns the first match when the same id appears in multiple messages', () => {
    const conv = makeConversation([
      { role: 'user', content: 'one' },
      { role: 'assistant', consentRequests: [approval('mcpr_dup')] },
      { role: 'user', content: 'two' },
      { role: 'assistant', consentRequests: [approval('mcpr_dup')] },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_dup')).toBe(1);
  });

  it('finds a match among multiple requests in the same message', () => {
    const conv = makeConversation([
      {
        role: 'assistant',
        consentRequests: [approval('mcpr_a'), approval('mcpr_b')],
      },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_b')).toBe(0);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_missing')).toBeNull();
  });
});
