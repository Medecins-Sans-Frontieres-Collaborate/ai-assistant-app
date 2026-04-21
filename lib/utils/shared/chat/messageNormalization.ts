import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
  ThinkingContent,
} from '@/types/chat';

type ValidContentBlock =
  | TextMessageContent
  | ImageMessageContent
  | FileMessageContent
  | ThinkingContent;

const VALID_BLOCK_TYPES = new Set<string>([
  'text',
  'image_url',
  'file_url',
  'thinking',
]);

function isValidContentBlock(item: unknown): item is ValidContentBlock {
  if (!item || typeof item !== 'object') return false;
  const type = (item as { type?: unknown }).type;
  return typeof type === 'string' && VALID_BLOCK_TYPES.has(type);
}

/**
 * Coerce a message's `content` into a shape the server's Zod schema accepts
 * (`string` or `Array<ContentBlock>`).
 *
 * Older conversations in localStorage can contain messages whose `content`
 * was persisted as `null`, a bare `{type:'text', text:'…'}` object, or some
 * other shape the current `Message` TypeScript union technically permits but
 * that server validation (`InputValidator.MessageContentSchema`) rejects with
 * "Invalid input". Storage-time sanitizers only check `content !== undefined`,
 * so these records survive hydration and poison subsequent chat requests at a
 * seemingly-arbitrary message index.
 *
 * This normalizer is applied at the API-call boundary so the server receives
 * only valid shapes, without touching UI render paths.
 */
export function normalizeMessageContent(
  content: unknown,
): string | ValidContentBlock[] {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content.filter(isValidContentBlock);
  }

  if (isValidContentBlock(content) && content.type === 'text') {
    return content.text;
  }

  return '';
}

/**
 * Apply {@link normalizeMessageContent} to every message in an array.
 * Returns a new array; input is not mutated.
 */
export function normalizeMessagesForAPI(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: normalizeMessageContent(message.content) as Message['content'],
  }));
}
