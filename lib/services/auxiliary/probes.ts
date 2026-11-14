/** Fixed synthetic fixtures using the real operation request builders; no user data or arbitrary prompts. */
import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import {
  type AssessmentInput,
  allowedVerdicts,
  assessmentSchema,
  buildAssessorSystemPrompt,
  buildAssessorUserMessage,
} from '@/lib/services/chat/tools/searchAssessor';
import {
  acceptReformulatedQuery,
  buildKnowledgeBaseReformulationPrompt,
  queryReformulationRequest,
} from '@/lib/services/search/queryReformulation';

import { MessageType } from '@/types/chat';

import { matchesAuxiliarySchema } from './schemaValidation';
import type { AuxiliaryOperation } from './types';

import type OpenAI from 'openai';

export { matchesAuxiliarySchema };

/** A tiny solid image: proves the deployment accepts image input. */
const PROBE_IMAGE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPQqDhBEmIY1TCqYfhqAADDSmgQBaIOewAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * The smallest value a JSON schema accepts: every declared property present,
 * the first enum value, nulls where allowed, empty strings and arrays.
 * Used only to answer captured probe requests.
 */
function minimalSchemaValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return null;
  const node = schema as {
    type?: string | string[];
    enum?: unknown[];
    properties?: Record<string, unknown>;
  };
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('null')) return null;
  switch (types[0]) {
    case 'object':
      return Object.fromEntries(
        Object.entries(node.properties ?? {}).map(([key, property]) => [
          key,
          minimalSchemaValue(property),
        ]),
      );
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'string':
      return '';
    default:
      return null;
  }
}

/** Build one synthetic request through the actual router builders, or the exported assessment schema. */
export async function auxiliaryProbeRequest(
  operation: AuxiliaryOperation,
): Promise<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> {
  if (operation === 'query')
    return queryReformulationRequest(
      buildKnowledgeBaseReformulationPrompt(
        'user: Synthetic readiness check. What is the latest news?',
        'What is the latest news?',
      ),
    );
  if (operation === 'mailScreen') {
    const { mailScreenRequest } =
      await import('@/lib/services/m365/tools/mailScreen');
    return mailScreenRequest({
      from: 'readiness@example.org',
      subject: 'Synthetic readiness check',
      bodyText: 'Hello. This is a synthetic readiness check with no links.',
    });
  }
  if (operation === 'mailAnalysis') {
    const { utilityJsonRequest } =
      await import('@/lib/services/m365/tools/mailOrchestration');
    // The shape every mail pass shares: system, envelope lines, strict
    // JSON. The schema mirrors the smallest real pass (query expansion).
    return utilityJsonRequest({
      system:
        'Suggest up to three short mailbox search queries for the request. Return JSON.',
      user: 'Request: synthetic readiness check about the quarterly report.',
      schemaName: 'mail_query_expansion',
      schema: {
        type: 'object',
        properties: { queries: { type: 'array', items: { type: 'string' } } },
        required: ['queries'],
        additionalProperties: false,
      },
    });
  }
  if (operation === 'schemaProposal') {
    const { flatSchemaProposalRequest } =
      await import('@/lib/utils/server/extraction/proposeFlatSchema');
    return flatSchemaProposalRequest(
      'Synthetic readiness check. Extract one row per project: project name, start date, budget in USD.',
    );
  }
  if (operation === 'mcpPlan') {
    const { mcpPlanRequest } =
      await import('@/lib/services/mcp/McpPlannerService');
    return mcpPlanRequest(
      'Synthetic readiness check: list my open issues.',
      'Connector "Readiness":\n- list_issues: Lists issues assigned to the user',
    );
  }
  if (operation === 'vision') {
    const { visionRequest } =
      await import('@/lib/services/m365/visionTranscription');
    return visionRequest(
      PROBE_IMAGE_PNG,
      'image/png',
      'Synthetic readiness check. Describe this image in one short sentence.',
    );
  }
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
                  // A schema-valid reply, so the router accepts it quietly
                  // (only the request matters here).
                  content: JSON.stringify(
                    minimalSchemaValue(
                      params.response_format?.type === 'json_schema'
                        ? params.response_format.json_schema.schema
                        : undefined,
                    ),
                  ),
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

/**
 * Whether a probe reply proves the deployment can serve the operation:
 * the operation's own acceptance rule for plain-text operations (`query`,
 * `vision`),
 * otherwise JSON matching the request's schema.
 *
 * @param operation - The operation the probe exercised.
 * @param params - The probe request (carries the JSON schema, if any).
 * @param response - The deployment's reply.
 */
export function auxiliaryProbeAccepts(
  operation: AuxiliaryOperation,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  response: OpenAI.Chat.Completions.ChatCompletion,
): boolean {
  const content = response.choices[0]?.message.content;
  if (operation === 'query')
    return acceptReformulatedQuery(content) !== undefined;
  if (operation === 'vision') return !!content?.trim();
  const schema =
    params.response_format?.type === 'json_schema'
      ? params.response_format.json_schema.schema
      : undefined;
  if (!schema) return false;
  try {
    return matchesAuxiliarySchema(JSON.parse(content ?? 'null'), schema);
  } catch {
    return false;
  }
}
