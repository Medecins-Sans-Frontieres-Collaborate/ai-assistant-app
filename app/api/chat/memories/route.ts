/**
 * Memory Extraction API
 *
 * Extracts durable, user-stated facts worth remembering across conversations
 * from a recent exchange, as add/update/delete operations against the
 * client's existing memory list. Best-effort: every failure soft-fails to
 * 200 { operations: [] } so chat UX never breaks.
 *
 * POST /api/chat/memories
 * Body: {
 *   messages: Message[],
 *   existingMemories: { id: string; text: string }[],
 *   modelId?: string,
 * }
 * Response: { operations: { op: 'add'|'update'|'delete', id?, text? }[] }
 */
import { NextRequest, NextResponse } from 'next/server';

import { InputValidator } from '@/lib/services/chat/validators/InputValidator';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import { isReasoningModel } from '@/lib/utils/app/chat';
import { OPENAI_API_VERSION } from '@/lib/utils/app/const';
import {
  badRequestResponse,
  errorResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { auth } from '@/auth';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import { AzureOpenAI } from 'openai';

export const maxDuration = 60;

// Scoped limiter — extraction fires at most once per completed exchange.
const limiter = RateLimiter.createScoped(20, 1);

// Defensive input caps — the client sends only the last few messages, but
// the route must bound its own LLM input regardless.
const MAX_INPUT_MESSAGES = 10;
const MAX_CHARS_PER_MESSAGE = 4000;
const MAX_EXISTING_MEMORIES = 100;
const MAX_MEMORY_CHARS = 600; // mirrors the memoryStore per-entry cap
const MAX_OPERATIONS = 20;

interface MemoryOperation {
  op: 'add' | 'update' | 'delete';
  id?: string;
  text?: string;
}

const MEMORIES_SYSTEM_PROMPT = `You maintain a small list of long-term memories about a user, extracted from their conversations with an AI assistant.

Extract ONLY durable, user-stated facts and preferences worth remembering across conversations: their role, stable preferences, constraints, and ongoing projects. Do NOT record transient task details, one-off requests, or anything about the current conversation's subject matter that will not stay relevant.

Compare against the existing memories: update an existing memory (by its id) instead of adding a near-duplicate, and delete a memory the user has explicitly contradicted or retracted. Each memory text must be a single short sentence.

Most exchanges contain nothing worth remembering — in that case return zero operations. Never invent facts the user did not state.`;

/**
 * Extracts only the text content of a message (files/images are dropped).
 */
function extractMessageText(message: Message): string {
  const { content } = message;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    // Cast: content is a union of array types, which blocks predicate
    // narrowing on .filter (same pattern as the title route).
    const items = content as (
      | TextMessageContent
      | FileMessageContent
      | ImageMessageContent
    )[];
    return items
      .filter((item): item is TextMessageContent => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
  }
  if (
    content &&
    typeof content === 'object' &&
    (content as TextMessageContent).type === 'text'
  ) {
    return (content as TextMessageContent).text;
  }
  return '';
}

/**
 * Cheap-model selection: anything that is not a plain azure-openai-SDK
 * chat-completions model — agent-prefixed (incl. byom-), unknown ids,
 * non-azure-openai SDKs (anthropic-foundry, Foundry openai), responses-API
 * and reasoning models — reroutes to GPT_5_2_CHAT. The route only ever
 * calls the Azure OpenAI deployments endpoint, so any other id would 404.
 */
function resolveDeploymentId(modelId: unknown): OpenAIModelID {
  const requested = typeof modelId === 'string' ? modelId : '';
  const model = OpenAIModels[requested as OpenAIModelID];
  const isAgentModel =
    requested.startsWith('foundry-') ||
    requested.startsWith('org-') ||
    requested.startsWith('custom-') ||
    requested.startsWith('byom-');
  return !requested ||
    isAgentModel ||
    !model ||
    model.sdk !== 'azure-openai' ||
    model.usesResponsesAPI ||
    isReasoningModel(requested)
    ? OpenAIModelID.GPT_5_2_CHAT
    : (requested as OpenAIModelID);
}

/**
 * Keeps only well-formed operations: 'add' needs text, 'delete' needs id,
 * 'update' needs both. Text has its whitespace collapsed to a single line
 * (memories render as system-prompt bullets — interior newlines could forge
 * markdown sections) and is truncated to the per-memory cap.
 */
function sanitizeOperations(raw: unknown): MemoryOperation[] {
  if (!Array.isArray(raw)) return [];
  const operations: MemoryOperation[] = [];
  for (const entry of raw.slice(0, MAX_OPERATIONS)) {
    if (!entry || typeof entry !== 'object') continue;
    const { op, id, text } = entry as Record<string, unknown>;
    if (op !== 'add' && op !== 'update' && op !== 'delete') continue;
    const cleanId = typeof id === 'string' && id.trim() ? id : undefined;
    const cleanText =
      typeof text === 'string' && text.trim()
        ? text.replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_CHARS)
        : undefined;
    if (op === 'add' && cleanText) {
      operations.push({ op, text: cleanText });
    } else if (op === 'update' && cleanId && cleanText) {
      operations.push({ op, id: cleanId, text: cleanText });
    } else if (op === 'delete' && cleanId) {
      operations.push({ op, id: cleanId });
    }
  }
  return operations;
}

const softFail = (): NextResponse =>
  NextResponse.json({ operations: [] }, { status: 200 });

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }
  const userId = session.user.id ?? session.user.mail ?? 'unknown';
  if (!limiter.checkLimit(userId).allowed) {
    return errorResponse('Too many requests', 429, undefined, 'RATE_LIMITED');
  }

  let messages: Message[];
  let existingMemories: { id: string; text: string }[];
  let modelId: unknown;
  try {
    const body = await req.json();
    if (!new InputValidator().validateRequestSize(body)) {
      return badRequestResponse('Request body too large (max 10MB)');
    }
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return badRequestResponse(
        'No messages provided or invalid messages format',
      );
    }
    if (
      body.existingMemories !== undefined &&
      !Array.isArray(body.existingMemories)
    ) {
      return badRequestResponse('existingMemories must be an array');
    }
    messages = body.messages as Message[];
    existingMemories = ((body.existingMemories ?? []) as unknown[])
      .slice(0, MAX_EXISTING_MEMORIES)
      .flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const { id, text } = entry as Record<string, unknown>;
        if (typeof id !== 'string' || typeof text !== 'string') return [];
        return [{ id, text: text.slice(0, MAX_MEMORY_CHARS) }];
      });
    modelId = body.modelId;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  try {
    const deploymentId = resolveDeploymentId(modelId);

    const azureADTokenProvider = getBearerTokenProvider(
      new DefaultAzureCredential(),
      'https://cognitiveservices.azure.com/.default',
    );
    const openai = new AzureOpenAI({
      azureADTokenProvider,
      deployment: deploymentId,
      apiVersion: OPENAI_API_VERSION,
    });

    const transcript = messages
      .slice(-MAX_INPUT_MESSAGES)
      .map(
        (m) =>
          `${m.role}: ${extractMessageText(m).slice(0, MAX_CHARS_PER_MESSAGE)}`,
      )
      .join('\n\n');

    const existingList =
      existingMemories.length > 0
        ? existingMemories.map((m) => `- [${m.id}] ${m.text}`).join('\n')
        : '(none)';
    const userMessage = `Existing memories:\n${existingList}\n\nRecent exchange:\n${transcript}`;

    const deploymentModel = OpenAIModels[deploymentId];
    const supportsTemperature = deploymentModel?.supportsTemperature !== false;

    const response = await openai.chat.completions.create({
      model: deploymentId,
      messages: [
        { role: 'system', content: MEMORIES_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      ...(supportsTemperature
        ? { temperature: 0.2, max_tokens: 500 }
        : { max_completion_tokens: 500 }),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'memory_operations',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              operations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    op: {
                      type: 'string',
                      enum: ['add', 'update', 'delete'],
                    },
                    // Strict json_schema requires every property listed in
                    // `required`; optionality is expressed via null.
                    id: {
                      type: ['string', 'null'],
                      description:
                        'Existing memory id (required for update/delete, null for add)',
                    },
                    text: {
                      type: ['string', 'null'],
                      description:
                        'Memory text (required for add/update, null for delete)',
                    },
                  },
                  required: ['op', 'id', 'text'],
                  additionalProperties: false,
                },
              },
            },
            required: ['operations'],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return softFail();
    }

    const parsed = JSON.parse(content) as { operations?: unknown };
    return NextResponse.json(
      { operations: sanitizeOperations(parsed.operations) },
      { status: 200 },
    );
  } catch (error) {
    // Memory extraction is best-effort — never surface an error to the chat UX.
    console.error('[Memory Extraction] Error:', error);
    return softFail();
  }
}
