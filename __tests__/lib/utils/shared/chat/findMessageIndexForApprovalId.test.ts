import { findMessageIndexForApprovalId } from '@/lib/utils/shared/chat/findMessageIndexForApprovalId';

import { Conversation, MessageType } from '@/types/chat';

import { emitConsentRequest } from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

function makeConversation(
  contents: Array<{ role: 'user' | 'assistant'; content: string }>,
): Conversation {
  return {
    id: 'c1',
    name: 'test',
    messages: contents.map((c) => ({
      role: c.role,
      content: c.content,
      messageType: MessageType.TEXT,
    })),
    model: { id: 'gpt-5.2', name: 'gpt-5.2' } as any,
    prompt: '',
    temperature: 0.5,
    folderId: null,
  };
}

describe('findMessageIndexForApprovalId', () => {
  const requestMarker = (id: string, toolName = 'do_thing') =>
    emitConsentRequest({
      kind: 'approval',
      approval_request_id: id,
      tool_name: toolName,
    });

  it('returns null when the approval id is empty', () => {
    const conv = makeConversation([
      { role: 'assistant', content: requestMarker('mcpr_1') },
    ]);
    expect(findMessageIndexForApprovalId(conv, '')).toBeNull();
  });

  it('returns null when no message contains the marker', () => {
    const conv = makeConversation([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello back' },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_1')).toBeNull();
  });

  it('locates the assistant message containing the marker', () => {
    const conv = makeConversation([
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: 'sure thing' + requestMarker('mcpr_target'),
      },
      { role: 'user', content: 'next message' },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_target')).toBe(1);
  });

  it('matches the structured field, not a stray mention in body text', () => {
    // The id appears in the body content of an assistant message but NOT
    // inside a CONSENT_REQUEST marker. The lookup should NOT match this.
    const conv = makeConversation([
      {
        role: 'assistant',
        content:
          "Just so you know, I'll be invoking approval id mcpr_phantom soon.",
      },
      {
        role: 'assistant',
        content: 'sure' + requestMarker('mcpr_phantom'),
      },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_phantom')).toBe(1);
  });

  it('does not match when the id is wrapped in a different field name', () => {
    const conv = makeConversation([
      {
        role: 'assistant',
        // Manually constructed so we can verify the field-aware match.
        content:
          '<<<CONSENT_REQUEST>>>{"kind":"approval","other_id":"mcpr_x","tool_name":"t"}<<<END_CONSENT_REQUEST>>>',
      },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_x')).toBeNull();
  });

  it('returns the first match when the same id appears in multiple messages', () => {
    const conv = makeConversation([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: requestMarker('mcpr_dup') },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: requestMarker('mcpr_dup') },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_dup')).toBe(1);
  });

  it('finds a marker among multiple in the same message', () => {
    const conv = makeConversation([
      {
        role: 'assistant',
        content:
          requestMarker('mcpr_a') +
          'middle text' +
          requestMarker('mcpr_b') +
          'tail',
      },
    ]);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_b')).toBe(0);
    expect(findMessageIndexForApprovalId(conv, 'mcpr_missing')).toBeNull();
  });

  it('skips messages whose content is not a string', () => {
    const conv: Conversation = {
      id: 'c1',
      name: 'test',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: requestMarker('mcpr_1') }],
          messageType: MessageType.TEXT,
        },
      ],
      model: { id: 'gpt-5.2', name: 'gpt-5.2' } as any,
      prompt: '',
      temperature: 0.5,
      folderId: null,
    };
    expect(findMessageIndexForApprovalId(conv, 'mcpr_1')).toBeNull();
  });
});
