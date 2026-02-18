import { Message } from '@/types/chat';
import { OpenAIModelID } from '@/types/openai';

import { isAudioVideoFile } from '@/lib/constants/fileTypes';

/**
 * Checks if any message contains audio or video files that need transcription
 */
export const isAudioVideoConversation = (messages: Message[]): boolean => {
  return messages.some((message) => {
    if (!Array.isArray(message.content)) return false;

    return message.content.some((content: any) => {
      if (content.type !== 'file_url') return false;

      // Check both URL and originalFilename for extension
      const filename = content.originalFilename || content.url || '';
      return isAudioVideoFile(filename);
    });
  });
};

/**
 * Check if model uses the special Responses API (reasoning models)
 */
export function isReasoningModel(id: OpenAIModelID | string): boolean {
  return (
    id === OpenAIModelID.GPT_o3 ||
    id === OpenAIModelID.DEEPSEEK_R1 ||
    id.includes('o3') ||
    id.includes('deepseek-r1')
  );
}

/**
 * Check if conversation contains images (checks only the last message)
 */
export const isImageConversation = (messages: Message[]): boolean => {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];
  if (Array.isArray(lastMessage.content)) {
    return lastMessage.content.some(
      (content: any) => content.type === 'image_url',
    );
  }
  return false;
};

/**
 * Check if conversation contains files (checks only the last message)
 */
export const isFileConversation = (messages: Message[]): boolean => {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];
  if (Array.isArray(lastMessage.content)) {
    return lastMessage.content.some(
      (content: any) => content.type === 'file_url',
    );
  }
  return false;
};

/**
 * Checks if a model ID represents a custom agent.
 * Prefer using model.isCustomAgent when the full model object is available.
 */
export const isCustomAgentModel = (modelId: string | undefined): boolean => {
  if (!modelId) return false;
  return modelId.startsWith('custom-');
};

/**
 * Checks if a model ID represents an organization agent.
 * Prefer using model.isOrganizationAgent when the full model object is available.
 */
export const isOrganizationAgentModel = (
  modelId: string | undefined,
): boolean => {
  if (!modelId) return false;
  return modelId.startsWith('org-');
};

/**
 * Validates if a model ID exists in the allowed model IDs or is a custom/organization agent
 */
export const checkIsModelValid = (
  modelId: string | undefined,
  allowedModelIds: Record<string, string> | typeof OpenAIModelID,
): boolean => {
  if (!modelId) return false;
  // Custom agents are always valid
  if (isCustomAgentModel(modelId)) return true;
  // Organization agents are always valid
  if (isOrganizationAgentModel(modelId)) return true;
  return Object.values(allowedModelIds).includes(modelId);
};

/**
 * Check if conversation contains both files and images (mixed content).
 * This requires special handling to combine file processing with image vision.
 */
export const isMixedFileImageConversation = (messages: Message[]): boolean => {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];
  if (!Array.isArray(lastMessage.content)) return false;

  let hasFile = false;
  let hasImage = false;

  for (const content of lastMessage.content) {
    if (content.type === 'file_url') hasFile = true;
    if (content.type === 'image_url') hasImage = true;

    // Early exit if we found both
    if (hasFile && hasImage) return true;
  }

  return false;
};
