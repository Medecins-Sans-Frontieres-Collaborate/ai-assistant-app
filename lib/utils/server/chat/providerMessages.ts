import { FileMessageContent, Message } from '@/types/chat';

import type OpenAI from 'openai';

/** The only message fields a chat.completions provider is allowed to see. */
export type ProviderMessageFields = Pick<Message, 'role' | 'content'>;

/**
 * Reduces an app message to the fields a chat.completions provider accepts.
 *
 * History messages carry app-internal bookkeeping — tool-call records,
 * citations, thinking, error flags, tone and prompt ids — that must never
 * reach the wire. Azure OpenAI ignores unknown message keys, but third-party
 * publishers behind Azure AI Foundry (Mistral and others) validate request
 * bodies strictly and reject the whole request. That surfaced as "the model
 * service rejected the request as invalid" on every follow-up turn after a
 * reply with tool records, in regions served by those models (issue #152).
 *
 * @param message - Validated app message from the conversation history.
 * @returns A new object holding only `role` and `content`.
 */
export function toProviderMessageFields(
  message: ProviderMessageFields,
): ProviderMessageFields {
  return { role: message.role, content: message.content };
}

/**
 * Converts app messages to chat.completions message params, dropping every
 * app-internal field. Content is forwarded unchanged; callers that need to
 * filter content parts (e.g. `file_url`) do so before or after this step.
 *
 * @param messages - Validated app messages in conversation order.
 * @returns Provider-shaped messages, one per input message.
 */
export function toProviderMessages(
  messages: ProviderMessageFields[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map(
    (message) =>
      toProviderMessageFields(
        message,
      ) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
  );
}

/**
 * Stand-in for a message whose every content part was removed before the
 * provider call and that named no file. Deliberately neutral: it used to
 * read "[File content could not be processed]", which told the model that
 * an earlier upload had FAILED when its content had simply been delivered
 * another way (active files, the code-interpreter sandbox), and the model
 * repeated that failure to the user.
 */
export const OMITTED_CONTENT_PLACEHOLDER =
  '[Attachment: its content is not repeated in this message]';

/** Longest filename quoted in an attachment reference. */
const ATTACHMENT_REFERENCE_NAME_MAX_CHARS = 200;

/** A filename made safe to quote inside a one-line bracketed reference. */
function quotableFilename(file: FileMessageContent): string {
  const name = file.originalFilename || file.url.split('/').pop() || 'file';
  return name
    .replace(/[\r\n[\]]+/g, ' ')
    .trim()
    .slice(0, ATTACHMENT_REFERENCE_NAME_MAX_CHARS);
}

/**
 * One-line reference to the files attached to a message, for use where the
 * `file_url` parts themselves are removed before the provider call.
 *
 * Only the turn's source message has its files extracted into the prompt;
 * every other message keeps just this reference, so the model still knows
 * which file was handed over at which point of the conversation and can
 * match it to the active-files context or the sandbox by name.
 *
 * @param content - The message's content parts, before filtering.
 * @returns The reference text, or undefined when no file is attached.
 *
 * @example
 * attachmentReferenceText([{ type: 'file_url', url: '/api/file/a.docx', originalFilename: 'Plan.docx' }]);
 * // => '[Attached file: Plan.docx. Its content is not repeated in this message.]'
 */
export function attachmentReferenceText(
  content: ReadonlyArray<{ type: string }>,
): string | undefined {
  const names = content
    .filter((part): part is FileMessageContent => part.type === 'file_url')
    .map(quotableFilename);
  if (names.length === 0) return undefined;
  return names.length === 1
    ? `[Attached file: ${names[0]}. Its content is not repeated in this message.]`
    : `[Attached files: ${names.join(', ')}. Their content is not repeated in this message.]`;
}
