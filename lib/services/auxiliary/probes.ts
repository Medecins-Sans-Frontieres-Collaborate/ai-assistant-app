/** Fixed synthetic fixtures using the real operation request builders; no user data or arbitrary prompts. */
import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import {
  type AssessmentInput,
  allowedVerdicts,
  assessmentSchema,
  buildAssessorSystemPrompt,
  buildAssessorUserMessage,
} from '@/lib/services/chat/tools/searchAssessor';

import { MessageType } from '@/types/chat';

import type { AuxiliaryOperation } from './types';

import type OpenAI from 'openai';

export { matchesAuxiliarySchema } from './schemaValidation';

/** Build one synthetic request through the actual router builders, or the exported assessment schema. */
export async function auxiliaryProbeRequest(
  operation: AuxiliaryOperation,
): Promise<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> {
  if (operation === 'assessment') {
    const input: AssessmentInput = {
      question: 'Synthetic readiness check: no sources',
      recentContext: [],
      today: new Date().toISOString().slice(0, 10),
      sources: [],
      steps: [],
      stepsRemaining: 0,
      exploratoryStepsRemaining: 0,
      canRead: false,
      maxReads: 0,
      maxUseful: 3,
      assessSources: false,
      searchHealth: '',
      strategiesTried: [],
      continuation: false,
    };
    return {
      model: '',
      messages: [
        {
          role: 'system',
          content: buildAssessorSystemPrompt(input),
        },
        { role: 'user', content: buildAssessorUserMessage(input) },
      ],
      max_completion_tokens: 2400,
      reasoning_effort: 'low',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'search_assessment',
          strict: true,
          schema: assessmentSchema(allowedVerdicts(input)),
        },
      },
    };
  }
  let captured:
    | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
    | undefined;
  const fake = {
    chat: {
      completions: {
        create: async (
          params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        ) => {
          captured = params;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    relevantSkills: [],
                    needsWebSearch: false,
                    isLengthReductionRequest: false,
                    targetIsAttachedDocument: false,
                  }),
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
  const router = new ToolRouterService(fake);
  const messages = [
    {
      role: 'user' as const,
      content: 'Hello. This is a synthetic readiness check.',
      messageType: MessageType.TEXT,
    },
  ];
  const catalog = [
    {
      id: 'platform-help',
      name: 'Platform Help',
      description: 'How to operate this application',
    },
  ];
  const request = {
    messages,
    currentMessage: 'Hello. This is a synthetic readiness check.',
    skillCatalog: catalog,
  };
  if (operation === 'skills') await router.determineSkills(request);
  if (operation === 'tools')
    await router.determineTool({
      ...request,
      considerCodeExecution: true,
      hasPriorSearchCitations: true,
      hasPriorSearchState: true,
      searchFanOut: true,
    });
  if (operation === 'trim')
    await router.classifyDocumentTrim({
      ...request,
      documentFilename: 'synthetic-readiness.docx',
    });
  if (!captured) throw new Error('Synthetic operation did not build a request');
  return captured;
}
