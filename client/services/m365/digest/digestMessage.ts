/**
 * The digest's home in a conversation (docs/M365_DAILY_DIGEST.md §6): a
 * user line stating what was asked, then an assistant message whose
 * `digest` state the card drives — pending while the job runs, the result
 * once done — and whose `content` is the markdown twin, so later turns can
 * refer to "the digest" like any other assistant text.
 */
import type {
  AssistantMessageGroup,
  Conversation,
  ConversationEntry,
  Message,
} from '@/types/chat';
import { isAssistantMessageGroup } from '@/types/chat';
import type { DigestMessageState, DigestRequest } from '@/types/m365Digest';

export function buildDigestMessages(
  userText: string,
  pendingText: string,
  jobId: string,
  request: DigestRequest,
): [Message, AssistantMessageGroup] {
  const userMessage: Message = {
    role: 'user',
    content: userText,
    messageType: 'TEXT',
  };
  const assistantMessage: AssistantMessageGroup = {
    type: 'assistant_group',
    activeIndex: 0,
    versions: [
      {
        content: pendingText,
        messageType: 'TEXT',
        createdAt: new Date().toISOString(),
        digest: { jobId, status: 'pending', request },
      },
    ],
  };
  return [userMessage, assistantMessage];
}

/**
 * Returns the conversation's entries with the digest message for `jobId`
 * patched, or null when no message carries that job (the user deleted it).
 */
export function patchDigestMessage(
  conversation: Pick<Conversation, 'messages'>,
  jobId: string,
  patch: (state: DigestMessageState) => {
    digest: DigestMessageState;
    content?: string;
  },
): ConversationEntry[] | null {
  let found = false;
  const messages = conversation.messages.map((entry): ConversationEntry => {
    if (isAssistantMessageGroup(entry)) {
      let touched = false;
      const versions = entry.versions.map((version) => {
        if (version.digest?.jobId !== jobId) return version;
        touched = true;
        const next = patch(version.digest);
        return {
          ...version,
          digest: next.digest,
          ...(next.content !== undefined && { content: next.content }),
        };
      });
      if (!touched) return entry;
      found = true;
      return { ...entry, versions };
    }
    if (entry.digest?.jobId !== jobId) return entry;
    found = true;
    const next = patch(entry.digest);
    return {
      ...entry,
      digest: next.digest,
      ...(next.content !== undefined && { content: next.content }),
    };
  });
  return found ? messages : null;
}
