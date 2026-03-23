import { VALIDATION_LIMITS } from '@/lib/utils/app/const';

import { Message } from '@/types/chat';

/**
 * Applies a sliding window to messages before sending to the API.
 * Preserves the first message (initial context) and the most recent messages.
 * Messages in the middle are dropped when the array exceeds maxMessages.
 *
 * @param messages - Flattened messages array
 * @param maxMessages - Maximum number of messages to keep (defaults to CLIENT_MAX_MESSAGES)
 * @returns Windowed messages array
 */
export function windowMessagesForAPI(
  messages: Message[],
  maxMessages: number = VALIDATION_LIMITS.CLIENT_MAX_MESSAGES,
): Message[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  // Always preserve the first message (initial context) and the most recent messages
  const firstMessage = messages[0];
  const recentMessages = messages.slice(-(maxMessages - 1));

  return [firstMessage, ...recentMessages];
}
