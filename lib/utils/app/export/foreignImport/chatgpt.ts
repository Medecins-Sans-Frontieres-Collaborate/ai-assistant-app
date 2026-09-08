/**
 * ChatGPT data-export adapter.
 *
 * `conversations.json` in a ChatGPT export is an array of conversations whose
 * messages form a TREE (`mapping`: node id → {parent, children, message}) —
 * regenerations and edits create sibling branches. Only one path through the
 * tree is what the user saw last; `current_node` points at its leaf. We walk
 * leaf → root and reverse, which reproduces the visible thread and drops the
 * abandoned branches. Branch preservation is deliberately out of scope for
 * tier 1 (see docs/CONVERSATION_IMPORT.md).
 */
import { ForeignConversation, ForeignTurn } from './types';

interface ChatGptAuthor {
  role?: string;
}

interface ChatGptContent {
  content_type?: string;
  parts?: unknown[];
  text?: string;
}

interface ChatGptMessage {
  id?: string;
  author?: ChatGptAuthor;
  create_time?: number | null;
  content?: ChatGptContent;
  recipient?: string;
  metadata?: {
    is_visually_hidden_from_conversation?: boolean;
    is_user_system_message?: boolean;
  };
}

interface ChatGptNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ChatGptMessage | null;
}

export interface ChatGptConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  mapping?: Record<string, ChatGptNode>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One conversation object as ChatGPT emits it: must have a node mapping. */
export const isChatGptConversation = (
  value: unknown,
): value is ChatGptConversation =>
  isRecord(value) && isRecord(value.mapping) && 'title' in value;

/**
 * Structural check for a ChatGPT `conversations.json` (an array of
 * conversations) or a single conversation object saved on its own.
 */
export const isChatGptExport = (data: unknown): boolean => {
  if (Array.isArray(data)) {
    return data.length > 0 && data.some(isChatGptConversation);
  }
  return isChatGptConversation(data);
};

const secondsToIso = (seconds: unknown): string | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return undefined;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * Pick the leaf of the visible branch. `current_node` is authoritative; when
 * it is missing or dangling, fall back to the most recently created leaf.
 */
const findLeafId = (conversation: ChatGptConversation): string | null => {
  const mapping = conversation.mapping ?? {};
  const current = conversation.current_node;
  if (current && mapping[current]) return current;

  let bestId: string | null = null;
  let bestTime = -Infinity;
  for (const [id, node] of Object.entries(mapping)) {
    if (node.children && node.children.length > 0) continue;
    const time = node.message?.create_time ?? 0;
    if (time > bestTime) {
      bestTime = time;
      bestId = id;
    }
  }
  return bestId;
};

/**
 * Root → leaf list of nodes on the visible branch. Guards against cycles and
 * dangling parent pointers so a corrupted export cannot loop forever.
 */
const walkVisibleBranch = (
  conversation: ChatGptConversation,
): ChatGptNode[] => {
  const mapping = conversation.mapping ?? {};
  const path: ChatGptNode[] = [];
  const seen = new Set<string>();
  let cursor = findLeafId(conversation);
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    const node = mapping[cursor];
    path.push(node);
    cursor = node.parent ?? null;
  }
  return path.reverse();
};

/**
 * Text of a message, or null when the message carries nothing we can show.
 * Returns the count of non-text parts (images, files) alongside so the caller
 * can report what was lost.
 */
const extractText = (
  message: ChatGptMessage,
): { text: string; dropped: number } | null => {
  const content = message.content;
  if (!content) return null;

  const type = content.content_type ?? 'text';
  if (type === 'text' || type === 'multimodal_text') {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    let dropped = 0;
    const texts: string[] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part.trim()) texts.push(part);
      } else if (isRecord(part)) {
        // Image pointers, audio transcriptions, file citations …
        if (typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text);
        } else {
          dropped += 1;
        }
      }
    }
    const text = texts.join('\n\n').trim();
    if (!text && dropped === 0) return null;
    return { text, dropped };
  }

  if (type === 'code' && typeof content.text === 'string') {
    // Assistant-authored code (Advanced Data Analysis). Keep it visible as a
    // fenced block rather than losing the reasoning step entirely.
    const code = content.text.trim();
    return code ? { text: `\`\`\`python\n${code}\n\`\`\``, dropped: 0 } : null;
  }

  // execution_output, tether_browsing_display, system_error, etc. are tool
  // plumbing, not conversation the user authored or read as a reply.
  return null;
};

const isVisibleTurn = (message: ChatGptMessage): boolean => {
  const role = message.author?.role;
  if (role !== 'user' && role !== 'assistant') return false;
  if (message.metadata?.is_visually_hidden_from_conversation) return false;
  // Assistant messages addressed to a tool (recipient !== 'all') are tool
  // calls — python source, browser commands — not the reply the user saw.
  if (
    role === 'assistant' &&
    message.recipient &&
    message.recipient !== 'all'
  ) {
    return false;
  }
  return true;
};

/**
 * Consecutive same-role nodes (e.g. an assistant code block followed by its
 * prose) collapse into one turn so the imported thread alternates cleanly.
 */
const appendTurn = (turns: ForeignTurn[], turn: ForeignTurn): void => {
  const last = turns[turns.length - 1];
  if (last && last.role === turn.role) {
    last.text = turn.text ? `${last.text}\n\n${turn.text}`.trim() : last.text;
    return;
  }
  turns.push({ ...turn });
};

/**
 * Convert one ChatGPT conversation. Returns null when nothing importable
 * remains (e.g. an empty conversation or one made only of tool output).
 */
export const parseChatGptConversation = (
  conversation: ChatGptConversation,
): ForeignConversation | null => {
  const turns: ForeignTurn[] = [];
  let droppedParts = 0;

  for (const node of walkVisibleBranch(conversation)) {
    const message = node.message;
    if (!message || !isVisibleTurn(message)) continue;
    const extracted = extractText(message);
    if (!extracted) continue;
    droppedParts += extracted.dropped;
    if (!extracted.text) continue;
    appendTurn(turns, {
      role: message.author?.role as 'user' | 'assistant',
      text: extracted.text,
      createdAt: secondsToIso(message.create_time),
    });
  }

  if (turns.length === 0) return null;

  const sourceId =
    (typeof conversation.conversation_id === 'string' &&
      conversation.conversation_id) ||
    (typeof conversation.id === 'string' && conversation.id) ||
    '';
  if (!sourceId) return null;

  return {
    source: 'chatgpt',
    sourceId,
    title:
      typeof conversation.title === 'string' && conversation.title.trim()
        ? conversation.title.trim()
        : '',
    createdAt: secondsToIso(conversation.create_time),
    updatedAt: secondsToIso(conversation.update_time),
    turns,
    droppedParts,
  };
};

/**
 * Convert a whole ChatGPT export. Malformed entries are counted in `skipped`
 * rather than aborting the import — one broken conversation should not cost
 * the user the other three hundred.
 */
export const parseChatGptExport = (
  data: unknown,
): { conversations: ForeignConversation[]; skipped: number } => {
  const raw = Array.isArray(data) ? data : [data];
  const conversations: ForeignConversation[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (!isChatGptConversation(entry)) {
      skipped += 1;
      continue;
    }
    try {
      const parsed = parseChatGptConversation(entry);
      if (parsed) conversations.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { conversations, skipped };
};
