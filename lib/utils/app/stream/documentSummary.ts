import { Session } from 'next-auth';

import {
  CHUNK_CONFIG,
  OPENAI_API_VERSION,
  TOKEN_ESTIMATION,
} from '@/lib/utils/app/const';
import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { ImageMessageContent } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { env } from '@/config/environment';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import OpenAI from 'openai';
import { AzureOpenAI } from 'openai';
import { ChatCompletion } from 'openai/resources';

/**
 * Estimates the chars-per-token ratio based on the dominant script type in the content.
 * Uses more conservative (lower) ratios for non-Latin scripts where tokens are shorter,
 * which results in larger character chunks to achieve the same token count.
 *
 * @param content - The text content to analyze
 * @param sampleSize - Number of characters to sample for analysis (default: 1000)
 * @returns The estimated characters per token ratio
 */
export function estimateCharsPerToken(
  content: string,
  sampleSize: number = 1000,
): number {
  // Sample first N chars for efficiency
  const sample = content.slice(0, sampleSize);
  if (sample.length === 0) {
    return TOKEN_ESTIMATION.LATIN;
  }

  // Count CJK characters (Chinese, Japanese Kanji, Korean Hanja)
  const cjkPattern = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
  const cjkCount = (sample.match(cjkPattern) || []).length;

  // Count Japanese Hiragana/Katakana
  const jpKanaPattern = /[\u3040-\u309F\u30A0-\u30FF]/g;
  const kanaCount = (sample.match(jpKanaPattern) || []).length;

  // Count Arabic/Hebrew
  const rtlPattern = /[\u0600-\u06FF\u0590-\u05FF]/g;
  const rtlCount = (sample.match(rtlPattern) || []).length;

  // Count Cyrillic
  const cyrillicPattern = /[\u0400-\u04FF]/g;
  const cyrillicCount = (sample.match(cyrillicPattern) || []).length;

  const cjkTotal = cjkCount + kanaCount;
  const rtlCyrillicTotal = rtlCount + cyrillicCount;
  const nonLatinCount = cjkTotal + rtlCyrillicTotal;
  const nonLatinRatio = nonLatinCount / sample.length;

  // If >30% non-Latin characters, use appropriate estimate
  if (nonLatinRatio > 0.3) {
    if (cjkTotal > rtlCyrillicTotal) {
      return TOKEN_ESTIMATION.CJK;
    }
    return TOKEN_ESTIMATION.RTL_CYRILLIC;
  }

  return TOKEN_ESTIMATION.LATIN;
}

/**
 * Configuration for document chunking, calculated based on model capabilities.
 */
interface ChunkConfig {
  /** Size of each document chunk in characters */
  chunkSize: number;
  /** Number of chunks to process in parallel per batch */
  batchSize: number;
  /** Maximum tokens for summarization completion */
  maxCompletionTokens: number;
  /** Maximum length of the combined summary in characters */
  maxSummaryLength: number;
}

/**
 * Calculates optimal chunk configuration based on the model's context window and output limits.
 *
 * The calculation strategy:
 * - Each chunk is processed individually by `summarizeChunk`, so we can use nearly the full
 *   context window for input (minus output tokens and prompt overhead).
 * - Chunk size: Available input tokens × chars per token, bounded by MIN/MAX_CHUNK_CHARS.
 * - Batch size: Scales with context window size (larger context = more parallel chunks).
 * - Max completion tokens: Based on model's output token limit, capped for efficiency.
 * - Max summary length: Scales with model output capacity for richer summaries.
 *
 * @param model - The OpenAI model configuration, or undefined for defaults
 * @param charsPerToken - Estimated characters per token ratio for the content script type
 * @returns ChunkConfig with calculated values
 */
export function calculateChunkConfig(
  model?: OpenAIModel,
  charsPerToken: number = TOKEN_ESTIMATION.LATIN,
): ChunkConfig {
  // Return defaults if no model provided
  if (!model) {
    console.log(
      '[DocumentSummary] Using default chunk config (no model provided)',
    );
    return {
      chunkSize: CHUNK_CONFIG.DEFAULT_CHUNK_CHARS,
      batchSize: CHUNK_CONFIG.DEFAULT_BATCH_SIZE,
      maxCompletionTokens: CHUNK_CONFIG.DEFAULT_MAX_COMPLETION_TOKENS,
      maxSummaryLength: CHUNK_CONFIG.DEFAULT_SUMMARY_LENGTH,
    };
  }

  // Calculate output tokens we'll actually use for the summary response
  const maxCompletionTokens = Math.min(
    CHUNK_CONFIG.DEFAULT_MAX_COMPLETION_TOKENS,
    Math.floor(model.tokenLimit / 4),
  );

  // Calculate available input tokens per chunk
  // Each chunk is processed individually, so we can use nearly the full context window
  const promptOverhead =
    CHUNK_CONFIG.SYSTEM_PROMPT_TOKENS + CHUNK_CONFIG.PROMPT_WRAPPER_TOKENS;
  const availableInputTokens =
    model.maxLength - maxCompletionTokens - promptOverhead;

  // Convert tokens to characters based on content script type
  const rawChunkSize = availableInputTokens * charsPerToken;

  // Apply bounds to chunk size
  const chunkSize = Math.max(
    CHUNK_CONFIG.MIN_CHUNK_CHARS,
    Math.min(CHUNK_CONFIG.MAX_CHUNK_CHARS, rawChunkSize),
  );

  // Batch size scales with context window
  // With larger chunks, we need fewer chunks in parallel
  const rawBatchSize = Math.floor(model.maxLength / 50000);
  const batchSize = Math.max(
    CHUNK_CONFIG.MIN_BATCH_SIZE,
    Math.min(CHUNK_CONFIG.MAX_BATCH_SIZE, rawBatchSize),
  );

  // Summary length scales with model output capacity
  const rawSummaryLength = model.tokenLimit * 2;
  const maxSummaryLength = Math.max(
    CHUNK_CONFIG.MIN_SUMMARY_LENGTH,
    Math.min(CHUNK_CONFIG.MAX_SUMMARY_LENGTH, rawSummaryLength),
  );

  console.log('[DocumentSummary] Chunk config calculated:', {
    model: model.id,
    modelMaxLength: model.maxLength,
    modelTokenLimit: model.tokenLimit,
    maxCompletionTokens,
    promptOverhead,
    availableInputTokens,
    charsPerToken,
    chunkSize,
    batchSize,
    maxSummaryLength,
  });

  return { chunkSize, batchSize, maxCompletionTokens, maxSummaryLength };
}

interface ParseAndQueryFilterOpenAIArguments {
  file: File;
  prompt: string;
  modelId: string;
  user: Session['user'];
  botId?: string;
  stream?: boolean;
  images?: ImageMessageContent[];
  /** Pre-extracted text content to avoid double extraction when caller already loaded the document */
  preExtractedText?: string;
}

/**
 * Summarizes a single chunk of document text with relevance to the user's prompt.
 *
 * @param azureOpenai - The OpenAI client instance
 * @param modelId - The model identifier to use for summarization
 * @param prompt - The user's original prompt to guide relevance filtering
 * @param chunk - The text chunk to summarize
 * @param user - The session user for API attribution
 * @param maxCompletionTokens - Maximum tokens for the completion response
 * @returns The summarized text, or null if summarization fails
 */
async function summarizeChunk(
  azureOpenai: OpenAI,
  modelId: string,
  prompt: string,
  chunk: string,
  user: Session['user'],
  maxCompletionTokens: number,
): Promise<string | null> {
  const summaryPrompt: string = `Summarize the following text with relevance to the prompt, but keep enough details to maintain the tone, character, and content of the original. If nothing is relevant, then return an empty string:\n\n\`\`\`prompt\n${prompt}\`\`\`\n\n\`\`\`text\n${chunk}\n\`\`\``;

  // Check if model supports custom temperature values
  const modelConfig = Object.values(OpenAIModels).find((m) => m.id === modelId);
  const supportsTemperature = modelConfig?.supportsTemperature !== false;

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
      ...(supportsTemperature && { temperature: 0.1 }),
      max_completion_tokens: maxCompletionTokens,
      stream: false,
      user: JSON.stringify(user),
    });

    return chunkSummary?.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (error: unknown) {
    console.error('Error summarizing chunk:', error);
    return null;
  }
}

/**
 * Parses a document file, summarizes its content, and queries an LLM with the user's prompt.
 *
 * This function handles large documents by:
 * 1. Loading the document and splitting into chunks (size based on model context window)
 * 2. Summarizing each chunk in parallel batches (batch size based on model capabilities)
 * 3. Combining summaries and sending to LLM with the user's prompt
 *
 * @param args - Configuration for document processing
 * @returns A ReadableStream for streaming responses, or a string for non-streaming
 */
export async function parseAndQueryFileOpenAI({
  file,
  prompt,
  modelId,
  user,
  botId,
  stream = true,
  images = [],
  preExtractedText,
}: ParseAndQueryFilterOpenAIArguments): Promise<ReadableStream | string> {
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

  // Use pre-extracted text if provided, otherwise load document
  const fileContent = preExtractedText ?? (await loadDocument(file));
  console.log(
    '[parseAndQueryFileOpenAI] File content loaded, length:',
    fileContent.length,
  );

  // Get model configuration for dynamic chunk sizing using direct key access
  console.log('[parseAndQueryFileOpenAI] Looking up model:', modelId);
  const modelConfig = OpenAIModels[modelId as OpenAIModelID];
  if (!modelConfig) {
    console.log(
      '[parseAndQueryFileOpenAI] Model not found in OpenAIModels, using defaults',
    );
  }

  // Estimate chars per token based on content script type
  const charsPerToken = estimateCharsPerToken(fileContent);
  console.log(
    '[parseAndQueryFileOpenAI] Estimated chars per token:',
    charsPerToken,
  );

  const chunkConfig = calculateChunkConfig(modelConfig, charsPerToken);

  let chunks: string[] = splitIntoChunks(fileContent, chunkConfig.chunkSize);
  console.log(
    '[parseAndQueryFileOpenAI] Split into chunks:',
    chunks.length,
    'chunk size:',
    chunkConfig.chunkSize,
  );

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

  while (chunks.length > 0) {
    const currentChunks = chunks.splice(0, chunkConfig.batchSize);
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
        chunkConfig.maxCompletionTokens,
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
      if ((batchSummary + summary).length > chunkConfig.maxSummaryLength) {
        break;
      }
      batchSummary += summary + ' ';
    }

    combinedSummary += batchSummary;
  }

  console.log(
    '[parseAndQueryFileOpenAI] Summarization complete, processed chunks:',
    processedChunkCount,
    'combined summary length:',
    combinedSummary.length,
  );

  // When non-streaming (pipeline mode), produce a content summary for the main LLM
  // to process with the user's query. When streaming, produce a direct response.
  const finalPrompt: string = stream
    ? `${combinedSummary}\n\nUser prompt: ${prompt}`
    : `${combinedSummary}\n\nThe user's query is: "${prompt}"\n\nProduce a comprehensive summary of the document content that is relevant to the user's query. Include key details, data, and context. Do NOT answer the query directly — just extract and organize the relevant content.`;

  const systemPrompt = stream
    ? 'You are a document analyzer AI Assistant. You perform all tasks the user requests of you, careful to make sure you are responding to the spirit and intentions behind their request. You make it clear how your responses relate to the base text that you are processing and provide your responses in markdown format when special formatting is necessary.'
    : "You are a document content extractor. Your job is to produce a clear, comprehensive summary of document content relevant to the user's query. Preserve key details, numbers, names, and structure. Do NOT answer the user's query — the summary you produce will be passed to another AI that will answer it.";

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

  // Check if model supports custom temperature values (reuse modelConfig from above)
  const supportsTemperature = modelConfig?.supportsTemperature !== false;

  const commonParams = {
    model: modelId,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userMessageContent,
      },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(supportsTemperature && { temperature: 0.1 }),
    max_completion_tokens: chunkConfig.maxCompletionTokens,
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

/**
 * Splits text into chunks of specified size for batch processing.
 *
 * @param text - The text content to split
 * @param chunkSize - The maximum size of each chunk in characters
 * @returns Array of text chunks
 */
export function splitIntoChunks(
  text: string,
  chunkSize: number = CHUNK_CONFIG.DEFAULT_CHUNK_CHARS,
): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}
