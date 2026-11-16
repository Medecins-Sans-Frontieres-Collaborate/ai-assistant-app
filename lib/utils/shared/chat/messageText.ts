import { Message, TextMessageContent } from '@/types/chat';

type MessageContent = Message['content'];

/** Whether a content part is a text part. */
function isTextPart(part: unknown): part is TextMessageContent {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  );
}

/**
 * The text a person typed in a message, whatever shape the content takes.
 *
 * A message with an upload stores its content as a list of parts (files,
 * images and text); a plain message stores a string. Display and editing
 * need the typed text in both cases.
 *
 * @param content - A message's content in any of its stored shapes.
 * @returns The typed text; several text parts are joined by a blank line.
 *   Empty when the content holds no text (an upload with no caption, or an
 *   extraction result).
 *
 * @example
 * messageText('hello'); // 'hello'
 * messageText([{ type: 'file_url', url: '…' }, { type: 'text', text: 'hi' }]); // 'hi'
 */
export function messageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as unknown[])
      .filter(isTextPart)
      .map((part) => part.text)
      .join('\n\n');
  }
  return isTextPart(content) ? content.text : '';
}

/**
 * Content with its typed text replaced and everything else kept, so editing
 * the caption of a message never drops its uploads.
 *
 * @param content - The content being edited.
 * @param text - The new text.
 * @returns Content of the same shape: a string stays a string, a single
 *   text part stays a text part, and a list keeps its files and images in
 *   place with one text part (at the position of the first original text
 *   part, or at the end when there was none). Content with no text slot (an
 *   extraction result) is returned unchanged.
 */
export function withMessageText(
  content: MessageContent,
  text: string,
): MessageContent {
  if (typeof content === 'string') return text;
  if (Array.isArray(content)) {
    const parts = content as Array<{ type: string }>;
    const textPart: TextMessageContent = { type: 'text', text };
    const firstTextIndex = parts.findIndex(isTextPart);
    const attachments = parts.filter((part) => !isTextPart(part));
    const insertAt =
      firstTextIndex === -1
        ? attachments.length
        : parts.slice(0, firstTextIndex).filter((part) => !isTextPart(part))
            .length;
    return [
      ...attachments.slice(0, insertAt),
      textPart,
      ...attachments.slice(insertAt),
    ] as MessageContent;
  }
  return isTextPart(content) ? { type: 'text', text } : content;
}
