/**
 * Chat Title Generation API
 *
 * Generates a concise, descriptive title for a conversation using Azure OpenAI
 * with structured outputs (JSON schema).
 *
 * POST /api/chat/title
 * Body: { messages: Message[], modelId: string }
 * Response: { title: string, fullTitle: string }
 */
import { NextRequest, NextResponse } from 'next/server';

import { isReasoningModel } from '@/lib/utils/app/chat';
import { OPENAI_API_VERSION } from '@/lib/utils/app/const';

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

/**
 * Response type for the title generation.
 */
interface ChatTitleResponse {
  title: string;
}

/**
 * Filters messages to only include text content.
 * Removes file and image content to focus on textual information for title generation.
 */
function filterMessagesForTitleGeneration(messages: Message[]): Message[] {
  return messages.map((message) => {
    // Handle string content
    if (typeof message.content === 'string') {
      return message;
    }

    // Handle array content - filter to only include text content
    if (Array.isArray(message.content)) {
      const textContents = (
        message.content as (
          | TextMessageContent
          | FileMessageContent
          | ImageMessageContent
        )[]
      ).filter(
        (item: TextMessageContent | FileMessageContent | ImageMessageContent) =>
          item.type === 'text',
      ) as TextMessageContent[];

      return {
        ...message,
        content:
          textContents.length > 0 ? textContents : [{ type: 'text', text: '' }],
      };
    }

    // Handle object content - only include if it's text type
    if (typeof message.content === 'object' && message.content !== null) {
      if ((message.content as TextMessageContent).type === 'text') {
        return message;
      } else {
        // Replace non-text content with empty text
        return {
          ...message,
          content: { type: 'text', text: '' },
        };
      }
    }

    return message;
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { messages, modelId } = body as {
      messages: Message[];
      modelId: string;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided or invalid messages format' },
        { status: 400 },
      );
    }

    // Initialize Azure OpenAI client
    const scope = 'https://cognitiveservices.azure.com/.default';
    const azureADTokenProvider = getBearerTokenProvider(
      new DefaultAzureCredential(),
      scope,
    );

    // Use GPT-5-mini for title generation (fast and cheap)
    // Fall back to it for reasoning models which are too expensive for this task
    const model = OpenAIModels[modelId as OpenAIModelID];
    const isAgentModel =
      modelId.startsWith('foundry-') ||
      modelId.startsWith('org-') ||
      modelId.startsWith('custom-');
    const deploymentId =
      isAgentModel || model?.usesResponsesAPI || isReasoningModel(modelId)
        ? OpenAIModelID.GPT_5_2_CHAT
        : (modelId as OpenAIModelID);

    const openai = new AzureOpenAI({
      azureADTokenProvider,
      deployment: deploymentId,
      apiVersion: OPENAI_API_VERSION,
    });

    // Prepare the system prompt for title generation
    const systemMessage = {
      role: 'system' as const,
      content: `Generate a concise, descriptive title for this conversation. The title should be less than 35 characters and should capture the main topic or purpose of the conversation. Use simple, direct language. Make it in whatever language the dominant conversation is in.`,
    };

    // Filter messages to only include text content
    const filteredMessages = filterMessagesForTitleGeneration(messages);

    // Define JSON schema for structured output
    const jsonSchema = {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string' as const,
          description:
            'A concise title for the conversation (less than 35 characters)',
        },
      },
      required: ['title'] as const,
      additionalProperties: false,
    };

    // Check if model supports custom temperature (also indicates API parameter format)
    const deploymentModel = OpenAIModels[deploymentId as OpenAIModelID];
    const supportsTemperature = deploymentModel?.supportsTemperature !== false;

    // Generate title using structured response
    const response = await openai.chat.completions.create({
      model: deploymentId,
      messages: [
        systemMessage,
        ...filteredMessages.map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content:
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .filter((c) => c.type === 'text')
                    .map((c) => (c as TextMessageContent).text)
                    .join('\n')
                : '',
        })),
      ],
      // Use appropriate parameters based on model capabilities
      ...(supportsTemperature
        ? { temperature: 0.7, max_tokens: 100 }
        : { max_completion_tokens: 100 }),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'title_response',
          strict: true,
          schema: jsonSchema,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from model');
    }

    const titleResponse: ChatTitleResponse = JSON.parse(content);

    return NextResponse.json(
      {
        title: titleResponse.title.slice(0, 31),
        fullTitle: titleResponse.title,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[Title Generation] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate title' },
      { status: 500 },
    );
  }
}
