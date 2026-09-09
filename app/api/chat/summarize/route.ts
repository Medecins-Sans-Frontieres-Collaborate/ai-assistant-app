/**
 * Conversation Compaction Summary API
 *
 * Produces/refreshes a dense summary of the earlier part of a conversation
 * that client-side context windowing no longer sends verbatim. Best-effort:
 * every failure soft-fails to 200 { summary: null } so chat UX never breaks.
 *
 * POST /api/chat/summarize
 * Body: { messages: Message[], previousSummary?: string, modelId?: string }
 * Response: { summary: string | null }
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

// Scoped limiter — compaction refreshes are occasional (post-stream,
// boundary-gated), so 20/min per user is generous.
const limiter = RateLimiter.createScoped(20, 1);

// Defensive input caps — the client already windows what it sends, but the
// route must bound its own LLM input regardless.
const MAX_INPUT_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 4000;
const MAX_PREVIOUS_SUMMARY_CHARS = 8000;
const MAX_SUMMARY_CHARS = 8000; // mirrors the ChatBodySchema wire cap

const SUMMARIZE_SYSTEM_PROMPT = `You maintain a rolling summary of the earlier part of a conversation between a user and an AI assistant.

Produce a dense, third-person summary (at most ~500 words) of the earlier conversation. If an existing summary is provided, merge it with the new messages into a single updated summary rather than appending.

Preserve: concrete facts, decisions made, names and terminology, constraints, and open questions. Drop pleasantries and repetition. Write in the dominant language of the conversation.`;

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
 * and reasoning models — reroutes to GPT_5_4 (deployed in both the US and
 * EU accounts). The route only ever calls the Azure OpenAI deployments
 * endpoint, so any other id would 404.
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
    ? OpenAIModelID.GPT_5_4
    : (requested as OpenAIModelID);
}

const softFail = (): NextResponse =>
  NextResponse.json({ summary: null }, { status: 200 });

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
  let previousSummary: string | undefined;
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
      body.previousSummary !== undefined &&
      typeof body.previousSummary !== 'string'
    ) {
      return badRequestResponse('previousSummary must be a string');
    }
    messages = body.messages as Message[];
    previousSummary = body.previousSummary as string | undefined;
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

    const cappedPreviousSummary = previousSummary
      ?.trim()
      .slice(0, MAX_PREVIOUS_SUMMARY_CHARS);
    const userMessage = cappedPreviousSummary
      ? `Existing summary of even earlier messages:\n${cappedPreviousSummary}\n\nNew messages to merge into the summary:\n${transcript}`
      : `Messages to summarize:\n${transcript}`;

    const deploymentModel = OpenAIModels[deploymentId];
    const supportsTemperature = deploymentModel?.supportsTemperature !== false;

    const response = await openai.chat.completions.create({
      model: deploymentId,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      ...(supportsTemperature
        ? { temperature: 0.3, max_tokens: 900 }
        : { max_completion_tokens: 900 }),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'conversation_summary',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description:
                  'Dense third-person summary of the earlier conversation (at most ~500 words)',
              },
            },
            required: ['summary'],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return softFail();
    }

    const parsed = JSON.parse(content) as { summary?: unknown };
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
      return softFail();
    }

    return NextResponse.json(
      { summary: parsed.summary.slice(0, MAX_SUMMARY_CHARS) },
      { status: 200 },
    );
  } catch (error) {
    // Summarization is best-effort — never surface an error to the chat UX.
    console.error('[Conversation Summarize] Error:', error);
    return softFail();
  }
}
