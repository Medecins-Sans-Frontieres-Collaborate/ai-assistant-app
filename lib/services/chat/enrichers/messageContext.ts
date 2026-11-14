/**
 * Adding server-side context to a message the model is about to read.
 *
 * Context that must sit right next to the user's words (search results, a
 * note about what did or did not run this turn) is merged INTO the last
 * user message rather than sent as a separate system message: some
 * providers accept only user and assistant roles, and a note far up the
 * prompt is easily outweighed by the conversation that follows it.
 */
import type { Message } from '@/types/chat';

/**
 * Prepends context text to a message's content, separated from the
 * original text by a rule. Handles string content and block arrays (the
 * text goes into the first text block, or a new one when there is none).
 *
 * @param message - The message to extend; not mutated.
 * @param context - Text to put in front of the message's own text.
 * @returns A copy of the message carrying the context.
 */
export function prependContextToMessage(
  message: Message,
  context: string,
): Message {
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: `${context}\n\n---\n\n${message.content}`,
    };
  }

  if (Array.isArray(message.content)) {
    const hasText = message.content.some((c) => c.type === 'text');
    if (hasText) {
      let modified = false;
      const modifiedContent = message.content.map((c) => {
        if (!modified && c.type === 'text' && 'text' in c) {
          modified = true;
          return { ...c, text: `${context}\n\n---\n\n${c.text}` };
        }
        return c;
      });
      return { ...message, content: modifiedContent } as Message;
    }
    return {
      ...message,
      content: [{ type: 'text', text: context }, ...message.content],
    } as Message;
  }

  return {
    ...message,
    content: `${context}\n\n---\n\n${String(message.content)}`,
  };
}
