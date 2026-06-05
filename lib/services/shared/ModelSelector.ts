import {
  checkIsModelValid,
  isCustomAgentModel,
  isImageConversation,
  isOrganizationAgentModel,
} from '@/lib/utils/app/chat';
import { DEFAULT_MODEL } from '@/lib/utils/app/const';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message } from '@/types/chat';
import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  OpenAIVisionModelID,
} from '@/types/openai';

/**
 * Service responsible for model selection, validation, and automatic upgrades.
 *
 * Handles:
 * - Model validation
 * - Automatic upgrade to vision models when images are detected
 * - Fallback to default model for invalid models
 * - Model configuration lookup
 */
export class ModelSelector {
  /**
   * Selects the appropriate model based on request context.
   *
   * @param requestedModel - The model requested by the client
   * @param messages - The conversation messages (used to detect images)
   * @returns Object containing the selected model ID and full model configuration
   */
  public selectModel(
    requestedModel: OpenAIModel,
    messages: Message[],
  ): { modelId: string; modelConfig: OpenAIModel } {
    const needsToHandleImages = isImageConversation(messages);
    const isCustomAgent = isCustomAgentModel(requestedModel.id);
    const isOrganizationAgent = isOrganizationAgentModel(requestedModel.id);
    const isValidModel = checkIsModelValid(requestedModel.id, OpenAIModelID);
    const isImageModel = checkIsModelValid(
      requestedModel.id,
      OpenAIVisionModelID,
    );

    let modelId = requestedModel.id;

    // Upgrade to vision model if images detected and current model doesn't support vision
    if (
      isValidModel &&
      needsToHandleImages &&
      !isImageModel &&
      !isCustomAgent &&
      !isOrganizationAgent
    ) {
      modelId = 'gpt-5';
      console.log(
        `[ModelSelector] Image detected - upgrading from ${requestedModel.id} to ${modelId} for vision support`,
      );
    }
    // Fallback to default model if invalid
    else if (modelId == null || !isValidModel) {
      modelId = DEFAULT_MODEL;
      console.log(
        `[ModelSelector] Invalid model ${sanitizeForLog(requestedModel.id)} - falling back to ${sanitizeForLog(modelId)}`,
      );
    }

    // Get model configuration
    // For custom/organization agents, use the model config passed in (which already has the full config)
    // For standard models, look up in OpenAIModels
    const modelConfig =
      (isCustomAgent || isOrganizationAgent) && modelId === requestedModel.id
        ? requestedModel
        : (Object.values(OpenAIModels).find((m) => m.id === modelId) as
            | OpenAIModel
            | undefined);

    if (!modelConfig) {
      throw new Error(`Model configuration not found for: ${modelId}`);
    }

    return { modelId, modelConfig };
  }

  /**
   * Validates if a model ID is valid.
   *
   * @param modelId - The model ID to validate
   * @returns true if valid, false otherwise
   */
  public isValidModel(modelId: string): boolean {
    return checkIsModelValid(modelId, OpenAIModelID);
  }

  /**
   * Checks if a model is a custom agent model.
   *
   * @param modelId - The model ID to check
   * @returns true if custom agent, false otherwise
   */
  public isCustomAgent(modelId: string): boolean {
    return isCustomAgentModel(modelId);
  }

  /**
   * Checks if a model supports vision (image understanding).
   *
   * @param modelId - The model ID to check
   * @returns true if supports vision, false otherwise
   */
  public supportsVision(modelId: string): boolean {
    return checkIsModelValid(modelId, OpenAIVisionModelID);
  }
}
