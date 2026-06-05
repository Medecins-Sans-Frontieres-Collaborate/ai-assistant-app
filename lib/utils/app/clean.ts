import {
  migrateLegacyMessages,
  needsMigration,
} from '@/lib/utils/shared/chat/messageVersioning';

import { Conversation, Message } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { DEFAULT_SYSTEM_PROMPT, DEFAULT_TEMPERATURE } from './const';

// Input is intentionally `unknown[]` — this runs at localStorage hydration
// time on user-supplied data that may predate any version of the Conversation
// schema. Each field is checked and defaulted individually below.
export const cleanConversationHistory = (
  history: unknown[],
): Conversation[] => {
  // added model for each conversation (3/20/23)
  // added system prompt for each conversation (3/21/23)
  // added folders (3/23/23)
  // added prompts (3/26/23)
  // added messages (4/16/23)

  if (!Array.isArray(history)) {
    console.warn('history is not an array. Returning an empty array.');
    return [];
  }

  return history.reduce<Conversation[]>((acc, raw) => {
    const conversation = raw as Partial<Conversation> & Record<string, unknown>;
    try {
      if (
        !conversation.model ||
        (conversation.model as OpenAIModel)?.isDisabled
      ) {
        // TODO: Replace with environmentally set default model so fixing doesn't require code change
        conversation.model = OpenAIModels[OpenAIModelID.GPT_5_2_CHAT];
      }

      if (!conversation.prompt) {
        conversation.prompt = DEFAULT_SYSTEM_PROMPT;
      }

      if (!conversation.temperature) {
        conversation.temperature = DEFAULT_TEMPERATURE;
      }

      if (!conversation.folderId) {
        conversation.folderId = null;
      }

      if (!conversation.messages) {
        conversation.messages = [];
      } else if (needsMigration(conversation.messages)) {
        // Migrate legacy assistant messages to AssistantMessageGroup format.
        // The cast is honest: messages reaching this branch predate
        // AssistantMessageGroup and are guaranteed flat Message[].
        conversation.messages = migrateLegacyMessages(
          conversation.messages as Message[],
        );
      }

      // After defaulting required fields above, this satisfies Conversation
      // structurally. Cast rather than re-validate each field at runtime.
      acc.push(conversation as Conversation);
      return acc;
    } catch (error) {
      console.warn(
        `error while cleaning conversations' history. Removing culprit`,
        error,
      );
    }
    return acc;
  }, []);
};

export const cleanMarkdown = (text: string): string => {
  // Remove headers (# symbols)
  text = text.replace(/^#+\s*/gm, '');
  // Remove asterisks for bold and italic
  text = text.replace(/[*_]{1,3}(.*?)[*_]{1,3}/g, '$1');
  // Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, '$1');
  // Remove links, keeping only the text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove horizontal rules
  text = text.replace(/^(-{3,}|\*{3,})$/gm, '');
  // Remove blockquotes
  text = text.replace(/^>\s*/gm, '');

  return text.trim();
};
