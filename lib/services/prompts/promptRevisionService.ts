import { apiClient } from '@/client/services';

/**
 * Interface for prompt revision/generation requests
 */
export interface PromptRevisionRequest {
  promptName: string;
  promptDescription: string;
  promptContent: string;
  revisionGoal?: string;
  generateNew: boolean;
  additionalContext?: string;
}

/**
 * Interface for individual improvements made to the prompt
 */
export interface PromptImprovement {
  category: string;
  description: string;
}

/**
 * Interface for prompt revision/generation responses
 */
export interface PromptRevisionResponse {
  success: boolean;
  revisedPrompt: string;
  improvements: PromptImprovement[];
  suggestions: string[];
  error?: string;
}

/**
 * Revises an existing prompt using AI
 * Extracted from PromptDashboard.tsx to improve testability and reusability
 *
 * @param request - The revision request parameters
 * @returns Promise resolving to the revision response
 * @throws Error if the API request fails
 *
 * @example
 * const result = await revisePrompt({
 *   promptName: 'Email Template',
 *   promptDescription: 'Professional email',
 *   promptContent: 'Write an email to {{recipient}}',
 *   revisionGoal: 'Make it more formal',
 *   generateNew: false,
 * });
 */
export const revisePrompt = async (
  request: PromptRevisionRequest,
): Promise<PromptRevisionResponse> => {
  return apiClient.post<PromptRevisionResponse>(
    '/api/chat/prompts/revise',
    request,
  );
};

/**
 * Generates a new prompt from scratch using AI
 *
 * @param params - Generation parameters (name, description, goal, context)
 * @returns Promise resolving to the generation response
 * @throws Error if the API request fails
 *
 * @example
 * const result = await generatePrompt({
 *   promptName: 'Meeting Summary',
 *   promptDescription: 'Summarize meetings',
 *   revisionGoal: 'Include action items and decisions',
 * });
 */
export const generatePrompt = async (params: {
  promptName: string;
  promptDescription: string;
  revisionGoal: string;
  additionalContext?: string;
}): Promise<PromptRevisionResponse> => {
  return revisePrompt({
    promptName: params.promptName,
    promptDescription: params.promptDescription,
    promptContent: '', // Empty for new generation
    revisionGoal: params.revisionGoal,
    generateNew: true,
    additionalContext: params.additionalContext,
  });
};

/**
 * Improves an existing prompt without specific goals
 * Uses the description as the improvement goal
 *
 * @param params - Prompt parameters
 * @returns Promise resolving to the revision response
 *
 * @example
 * const result = await improvePrompt({
 *   promptName: 'Code Review',
 *   promptDescription: 'Review code quality',
 *   promptContent: 'Review this code: {{code}}',
 * });
 */
export const improvePrompt = async (params: {
  promptName: string;
  promptDescription: string;
  promptContent: string;
  additionalContext?: string;
}): Promise<PromptRevisionResponse> => {
  return revisePrompt({
    ...params,
    revisionGoal: params.promptDescription,
    generateNew: false,
  });
};
