/** Fixed synthetic fixtures using the real operation request builders; no user data or arbitrary prompts. */
import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import { assessmentSchema } from '@/lib/services/chat/tools/searchAssessor';

import { MessageType } from '@/types/chat';

import type { AuxiliaryOperation } from './types';

import type OpenAI from 'openai';

/** Validate the closed, provider-neutral JSON schema subset used by our classifiers. */
export function matchesAuxiliarySchema(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((key) => typeof key !== 'string' || !(key in object))
    )
      return false;
    return Object.entries(object).every(([key, entry]) =>
      properties[key]
        ? matchesAuxiliarySchema(entry, properties[key])
        : schema.additionalProperties !== false,
    );
  }
  if (schema.type === 'array')
    return (
      Array.isArray(value) &&
      (typeof schema.maxItems !== 'number' ||
        value.length <= schema.maxItems) &&
      value.every((entry) =>
        matchesAuxiliarySchema(
          entry,
          (schema.items ?? {}) as Record<string, unknown>,
        ),
      )
    );
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number')
    return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'integer')
    return typeof value === 'number' && Number.isInteger(value);
  return true;
}

/** Build one synthetic request through the actual router builders, or the exported assessment schema. */
export async function auxiliaryProbeRequest(
  operation: AuxiliaryOperation,
): Promise<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> {
  if (operation === 'assessment')
    return {
      model: '',
      messages: [
        {
          role: 'system',
          content:
            'Return a JSON search assessment. No sources are available. Choose give_up, empty lists, false exploratory, and empty strings where no detail is needed.',
        },
        { role: 'user', content: 'Synthetic readiness check: no sources.' },
      ],
      max_completion_tokens: 2400,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'search_assessment',
          strict: true,
          schema: assessmentSchema(['give_up']),
        },
      },
    };
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
