import { Message } from '@/types/chat';

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
