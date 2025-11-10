import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { v4 as uuidv4 } from 'uuid';

/**
 * Creates a default conversation with proper model configuration
 *
 * @param models - Available models array
 * @param defaultModelId - ID of the default model to use (optional)
 * @param systemPrompt - System prompt to initialize with
 * @param temperature - Temperature setting for the conversation
 * @param defaultSearchMode - Default search mode for the conversation (optional, defaults to INTELLIGENT)
 * @returns A new conversation object
 *
 * @example
 * const conversation = createDefaultConversation(
 *   models,
 *   'gpt-4o',
 *   'You are a helpful assistant',
 *   0.5,
 *   SearchMode.INTELLIGENT
 * );
 */
export const createDefaultConversation = (
  models: OpenAIModel[],
  defaultModelId: string | undefined,
  systemPrompt: string,
  temperature: number,
  defaultSearchMode?: SearchMode,
): Conversation => {
  // Use the persisted defaultModelId if available, otherwise fall back to first model
  const defaultModel = defaultModelId
    ? models.find((m) => m.id === defaultModelId) || models[0]
    : models[0];

  if (!defaultModel) {
    throw new Error('No models available');
  }

  // Determine appropriate search mode based on model capabilities
  // If the model is an agent (has agentId), use the provided search mode
  // Otherwise, ensure we don't use AGENT mode on non-agent models
  let searchMode = defaultSearchMode ?? SearchMode.INTELLIGENT;
  if (searchMode === SearchMode.AGENT && !defaultModel.agentId) {
    // Auto-fix: If default is AGENT but model doesn't support it, use INTELLIGENT instead
    searchMode = SearchMode.INTELLIGENT;
  }

  return {
    id: uuidv4(),
    name: 'New Conversation',
    messages: [],
    model: defaultModel,
    prompt: systemPrompt || '',
    temperature: temperature || 0.5,
    folderId: null,
    defaultSearchMode: searchMode, // Privacy-focused intelligent search by default, model-appropriate
  };
};

/**
 * Checks if conversation initialization should proceed
 * Validates that all required data is loaded
 *
 * @param isLoaded - Whether conversations are loaded from storage
 * @param hasModels - Whether models are available
 * @returns True if initialization can proceed
 */
export const canInitializeConversation = (
  isLoaded: boolean,
  hasModels: boolean,
): boolean => {
  return isLoaded && hasModels;
};

/**
 * Determines if a new default conversation should be created
 *
 * @param conversations - Current conversations array
 * @returns True if a default conversation should be created
 */
export const shouldCreateDefaultConversation = (
  conversations: Conversation[],
): boolean => {
  return conversations.length === 0;
};
