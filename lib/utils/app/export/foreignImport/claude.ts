/**
 * Claude data-export adapter.
 *
 * `conversations.json` in a Claude export is an array of conversations, each
 * with a linear `chat_messages` list — no branching to resolve. Message text
 * lives in `content[]` blocks (preferred) with a flattened `text` fallback on
 * older exports. Attachments ship as separate files in the zip and are not
 * carried over; their count is reported as `droppedParts`.
 */
import { ForeignConversation, ForeignTurn } from './types';

interface ClaudeContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeMessage {
  uuid?: string;
  text?: string;
  sender?: string;
  created_at?: string;
  content?: ClaudeContentBlock[];
  attachments?: unknown[];
  files?: unknown[];
}

export interface ClaudeConversation {
  uuid?: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isClaudeConversation = (
  value: unknown,
): value is ClaudeConversation =>
  isRecord(value) &&
  typeof value.uuid === 'string' &&
  Array.isArray(value.chat_messages);

export const isClaudeExport = (data: unknown): boolean => {
  if (Array.isArray(data)) {
    return data.length > 0 && data.some(isClaudeConversation);
  }
  return isClaudeConversation(data);
};

const toIso = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const roleOf = (sender: unknown): ForeignTurn['role'] | null => {
  if (sender === 'human' || sender === 'user') return 'user';
  if (sender === 'assistant') return 'assistant';
  return null;
};

const extractText = (
  message: ClaudeMessage,
): { text: string; dropped: number } => {
  let dropped = 0;
  const texts: string[] = [];
  if (Array.isArray(message.content) && message.content.length > 0) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim()) texts.push(block.text);
      } else if (block.type === 'tool_use' || block.type === 'tool_result') {
        // Artifacts / tool plumbing — not conversation the user typed or
        // read as prose. Counted so the picker can say "N parts dropped".
        dropped += 1;
      } else if (block.type !== 'thinking') {
        dropped += 1;
      }
    }
  }
  if (texts.length === 0 && typeof message.text === 'string') {
    if (message.text.trim()) texts.push(message.text);
  }
  const attachmentCount =
    (Array.isArray(message.attachments) ? message.attachments.length : 0) +
    (Array.isArray(message.files) ? message.files.length : 0);
  return {
    text: texts.join('\n\n').trim(),
    dropped: dropped + attachmentCount,
  };
};

const appendTurn = (turns: ForeignTurn[], turn: ForeignTurn): void => {
  const last = turns[turns.length - 1];
  if (last && last.role === turn.role) {
    last.text = `${last.text}\n\n${turn.text}`.trim();
    return;
  }
  turns.push({ ...turn });
};

export const parseClaudeConversation = (
  conversation: ClaudeConversation,
): ForeignConversation | null => {
  const turns: ForeignTurn[] = [];
  let droppedParts = 0;

  for (const message of conversation.chat_messages ?? []) {
    if (!isRecord(message)) continue;
    const role = roleOf(message.sender);
    if (!role) continue;
    const { text, dropped } = extractText(message);
    droppedParts += dropped;
    if (!text) continue;
    appendTurn(turns, { role, text, createdAt: toIso(message.created_at) });
  }

  if (turns.length === 0 || typeof conversation.uuid !== 'string') return null;

  return {
    source: 'claude',
    sourceId: conversation.uuid,
    title:
      typeof conversation.name === 'string' && conversation.name.trim()
        ? conversation.name.trim()
        : '',
    createdAt: toIso(conversation.created_at),
    updatedAt: toIso(conversation.updated_at),
    turns,
    droppedParts,
  };
};

export const parseClaudeExport = (
  data: unknown,
): { conversations: ForeignConversation[]; skipped: number } => {
  const raw = Array.isArray(data) ? data : [data];
  const conversations: ForeignConversation[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (!isClaudeConversation(entry)) {
      skipped += 1;
      continue;
    }
    try {
      const parsed = parseClaudeConversation(entry);
      if (parsed) conversations.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { conversations, skipped };
};
