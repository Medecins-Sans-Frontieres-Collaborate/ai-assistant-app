import { Session } from 'next-auth';

import { OPENAI_API_VERSION } from '@/lib/utils/app/const';
import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';
import { loadDocument } from '@/lib/utils/server/file-handling';
import { sanitizeForLog } from '@/lib/utils/server/logSanitization';

import { ImageMessageContent } from '@/types/chat';

import { env } from '@/config/environment';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import OpenAI from 'openai';
import { AzureOpenAI } from 'openai';
import { ChatCompletion } from 'openai/resources';

interface ParseAndQueryFilterOpenAIArguments {
  file: File;
  prompt: string;
  modelId: string;
  maxLength?: number;
  user: Session['user'];
  botId?: string;
  stream?: boolean;
  images?: ImageMessageContent[];
}

async function summarizeChunk(
  azureOpenai: OpenAI,
  modelId: string,
  prompt: string,
  chunk: string,
  user: Session['user'],
  startTimeChunk: number,
  filename?: string,
  fileSize?: number,
): Promise<string | null> {
  const summaryPrompt: string = `Summarize the following text with relevance to the prompt, but keep enough details to maintain the tone, character, and content of the original. If nothing is relevant, then return an empty string:\n\n\`\`\`prompt\n${prompt}\`\`\`\n\n\`\`\`text\n${chunk}\n\`\`\``;

  try {
    const chunkSummary = await azureOpenai.chat.completions.create({
      model: modelId,
      messages: [
        {
          role: 'system',
          content:
            'You are an AI Text summarizer. You take the prompt of a user and rather than conclusively answering, you pull together all the relevant information for that prompt in a particular chunk of text and reshape that into brief statements capturing the nuanced intent of the original text.',
        },
        {
          role: 'user',
          content: summaryPrompt,
        },
      ],
      temperature: 0.1,
      max_completion_tokens: 5000,
      stream: false,
      user: JSON.stringify(user),
    });

    return chunkSummary?.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (error: any) {
    console.error('Error summarizing chunk:', error);
    return null;
  }
}

export async function parseAndQueryFileOpenAI({
  file,
  prompt,
  modelId,
  maxLength = 6000,
  user,
  botId,
  stream = true,
  images = [],
}: ParseAndQueryFilterOpenAIArguments): Promise<ReadableStream | string> {
  const startTime = Date.now();
  console.log(
    '[parseAndQueryFileOpenAI] Starting with file:',
    sanitizeForLog(file.name),
    'size:',
    sanitizeForLog(file.size),
    'stream:',
    sanitizeForLog(stream),
  );
  console.log(
    '[parseAndQueryFileOpenAI] Prompt length:',
    sanitizeForLog(prompt.length),
  );

  const fileContent = await loadDocument(file);
  console.log(
    '[parseAndQueryFileOpenAI] File content loaded, length:',
    fileContent.length,
  );

  let chunks: string[] = splitIntoChunks(fileContent);
  console.log('[parseAndQueryFileOpenAI] Split into chunks:', chunks.length);

  const scope = 'https://cognitiveservices.azure.com/.default';
  const azureADTokenProvider = getBearerTokenProvider(
    new DefaultAzureCredential(),
    scope,
  );

  const client = new AzureOpenAI({
    azureADTokenProvider,
    deployment: modelId,
    apiVersion: OPENAI_API_VERSION,
  });

  let combinedSummary: string = '';
  let processedChunkCount = 0;
  let totalChunkCount = chunks.length;

  while (chunks.length > 0) {
    const currentChunks = chunks.splice(0, 5);
    console.log(
      `[parseAndQueryFileOpenAI] Processing batch of ${currentChunks.length} chunks, ${chunks.length} remaining`,
    );

    const summaryPromises = currentChunks.map((chunk) =>
      summarizeChunk(
        client,
        modelId,
        prompt,
        chunk,
        user,
        Date.now(),
        file.name,
        file.size,
      ),
    );

    const summaries = await Promise.all(summaryPromises);
    console.log(
      '[parseAndQueryFileOpenAI] Batch completed, summaries received:',
      summaries.filter((s) => s !== null).length,
    );

    const validSummaries = summaries.filter((summary) => summary !== null);
    processedChunkCount += validSummaries.length;

    let batchSummary = '';
    for (const summary of validSummaries) {
      if ((batchSummary + summary).length > maxLength) {
        break;
      }
      batchSummary += summary + ' ';
    }

    combinedSummary += batchSummary;
  }

  const finalPrompt: string = `${combinedSummary}\n\nUser prompt: ${prompt}`;

  // Build user message content - include images if present
  const userMessageContent:
    | string
    | OpenAI.Chat.Completions.ChatCompletionContentPart[] =
    images.length > 0
      ? [
          ...images.map((img) => ({
            type: 'image_url' as const,
            image_url: img.image_url,
          })),
          {
            type: 'text' as const,
            text: finalPrompt,
          },
        ]
      : finalPrompt;

  const commonParams = {
    model: modelId,
    messages: [
      {
        role: 'system',
        content:
          'You are a document analyzer AI Assistant. You perform all tasks the user requests of you, careful to make sure you are responding to the spirit and intentions behind their request. You make it clear how your responses relate to the base text that you are processing and provide your responses in markdown format when special formatting is necessary.',
      },
      {
        role: 'user',
        content: userMessageContent,
      },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: 0.1,
    max_completion_tokens: 5000,
    stream: stream,
    user: JSON.stringify(user),
  };

  console.log(
    '[parseAndQueryFileOpenAI] Creating chat completion, botId:',
    sanitizeForLog(botId),
  );
  let response;
  if (botId) {
    console.log('[parseAndQueryFileOpenAI] Using bot with data sources');
    response = await client.chat.completions.create({
      ...commonParams,
      //@ts-ignore
      data_sources: [
        {
          type: 'azure_search',
          parameters: {
            endpoint: env.SEARCH_ENDPOINT,
            index_name: env.SEARCH_INDEX,
            authentication: {
              type: 'api_key',
              key: env.SEARCH_ENDPOINT_API_KEY,
            },
          },
        },
      ],
    });
  } else {
    console.log('[parseAndQueryFileOpenAI] Using standard chat completion');
    response = await client.chat.completions.create(commonParams);
  }

  console.log(
    '[parseAndQueryFileOpenAI] Got response, stream:',
    sanitizeForLog(stream),
  );

  if (stream) {
    return createAzureOpenAIStreamProcessor(
      response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    );
  } else {
    const completionText =
      (response as ChatCompletion)?.choices?.[0]?.message?.content?.trim() ??
      '';
    if (!completionText) {
      throw new Error(
        `Empty response returned from API! ${JSON.stringify(response)}`,
      );
    }

    return completionText;
  }
}

export function splitIntoChunks(
  text: string,
  chunkSize: number = 6000,
): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}
