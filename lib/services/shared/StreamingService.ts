import { isReasoningModel } from '@/lib/utils/app/chat';
import { DEFAULT_TEMPERATURE } from '@/lib/utils/app/const';

import { OpenAIModelID } from '@/types/openai';

/**
 * Service responsible for determining streaming and temperature settings.
 *
 * Handles:
 * - Streaming support detection (reasoning models don't support streaming)
 * - Temperature configuration (reasoning models use fixed temperature)
 */
export class StreamingService {
  /**
   * Determines if streaming should be used for a given model.
   *
   * Some models (like o3) do not support streaming due to API limitations.
   *
   * @param modelId - The model ID to check
   * @param requestedStream - Whether the client requested streaming
   * @param modelConfig - Optional model configuration to check stream support
   * @returns true if streaming should be used, false otherwise
   */
  public shouldStream(
    modelId: OpenAIModelID | string,
    requestedStream: boolean,
    modelConfig?: { stream?: boolean },
  ): boolean {
    // Check if model explicitly disables streaming (e.g., o3)
    if (modelConfig && modelConfig.stream === false) {
      return false;
    }

    return requestedStream;
  }

  /**
   * Determines the appropriate temperature for a given model.
   *
   * Reasoning models (o1, o1-mini, o3-mini, etc.) use a fixed temperature of 1
   * and do not allow custom temperature configuration.
   *
   * @param modelId - The model ID to check
   * @param requestedTemperature - The temperature requested by the client (optional)
   * @returns The appropriate temperature to use
   */
  public getTemperature(
    modelId: OpenAIModelID | string,
    requestedTemperature?: number,
  ): number {
    // Reasoning models use fixed temperature of 1
    if (isReasoningModel(modelId)) {
      return 1;
    }

    // Use requested temperature or default
    return requestedTemperature ?? DEFAULT_TEMPERATURE;
  }

  /**
   * Checks if a model is a reasoning model.
   *
   * @param modelId - The model ID to check
   * @returns true if reasoning model, false otherwise
   */
  public isReasoningModel(modelId: string): boolean {
    return isReasoningModel(modelId);
  }

  /**
   * Gets the full configuration for streaming and temperature.
   *
   * Convenience method that combines shouldStream and getTemperature.
   *
   * @param modelId - The model ID
   * @param requestedStream - Whether streaming was requested
   * @param requestedTemperature - The requested temperature (optional)
   * @param modelConfig - Optional model configuration to check stream support
   * @returns Object with stream and temperature settings
   */
  public getStreamConfig(
    modelId: OpenAIModelID | string,
    requestedStream: boolean,
    requestedTemperature?: number,
    modelConfig?: { stream?: boolean },
  ): { stream: boolean; temperature: number } {
    return {
      stream: this.shouldStream(modelId, requestedStream, modelConfig),
      temperature: this.getTemperature(modelId, requestedTemperature),
    };
  }
}
