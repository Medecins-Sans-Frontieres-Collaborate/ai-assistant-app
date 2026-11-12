import type { TextCompleter } from '@/lib/services/chat/textCompletion';

import { CHUNK_CONFIG, TOKEN_ESTIMATION } from '@/lib/utils/app/const';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  admissibleRequestTokens,
  applyAdmissionCeiling,
} from '@/lib/utils/shared/modelThroughput';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { performance } from 'perf_hooks';

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
 * - Batch size: Scales with context window size (larger context = more parallel chunks),
 *   capped — when the model carries `tokensPerMinute` — at how many chunk requests the
 *   deployment can admit at once (minimum 1).
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
  const windowBatchSize = Math.max(
    CHUNK_CONFIG.MIN_BATCH_SIZE,
    Math.min(CHUNK_CONFIG.MAX_BATCH_SIZE, rawBatchSize),
  );
  // A batch is sent all at once, so it must fit the deployment's per-minute
  // admission budget too: 5 near-window chunks against a 250K TPM deployment
  // is ~1.2M tokens in one burst, and every call in it is 429'd. Throughput
  // overrides MIN_BATCH_SIZE — a floor that guarantees rejection helps no one.
  const batchSize =
    model.tokensPerMinute !== undefined
      ? Math.max(
          1,
          Math.min(
            windowBatchSize,
            Math.floor(
              admissibleRequestTokens(model.tokensPerMinute) /
                (Math.ceil(chunkSize / charsPerToken) +
                  maxCompletionTokens +
                  promptOverhead),
            ),
          ),
        )
      : windowBatchSize;

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
    tokensPerMinute: model.tokensPerMinute,
    maxSummaryLength,
  });

  return { chunkSize, batchSize, maxCompletionTokens, maxSummaryLength };
}

/** Arguments for {@link summarizeDocumentForQuery}. */
interface SummarizeDocumentArguments {
  /** The uploaded document; read only when `preExtractedText` is absent. */
  file: File;
  /** The user's question; the summary keeps what is relevant to it. */
  prompt: string;
  /** Catalog id of the chat model, used to size chunks and batches. */
  modelId: string;
  /**
   * Runs one completion on the turn's chat model, under the turn's region
   * or custom-source routing (see lib/services/chat/textCompletion.ts).
   */
  complete: TextCompleter;
  /** Pre-extracted text content to avoid double extraction when caller already loaded the document */
  preExtractedText?: string;
  /**
   * Batch-level progress callback (chunks attempted so far, total chunks).
   * Large documents mean dozens of sequential LLM batches — callers use this
   * to keep the client's loader honest instead of silent for minutes.
   */
  onProgress?: (processedChunks: number, totalChunks: number) => void;
  /**
   * TPM limit of the deployment serving `modelId` (ChatContext
   * .servingTokensPerMinute). Caps chunk size and parallelism so summary
   * calls fit what the deployment admits; undefined = catalog sizing.
   */
  servingTokensPerMinute?: number;
}

/** Outcome of one chunk: its summary text, or the error that lost it. */
type ChunkSummaryResult =
  | { ok: true; summary: string }
  | { ok: false; error: unknown };

const CHUNK_SUMMARY_SYSTEM_PROMPT =
  'You are an AI Text summarizer. You take the prompt of a user and rather than conclusively answering, you pull together all the relevant information for that prompt in a particular chunk of text and reshape that into brief statements capturing the nuanced intent of the original text.';

const FINAL_SUMMARY_SYSTEM_PROMPT =
  "You are a document content extractor. Your job is to produce a clear, comprehensive summary of document content relevant to the user's query. Preserve key details, numbers, names, and structure. Do NOT answer the user's query — the summary you produce will be passed to another AI that will answer it.";

/** Low temperature: the summary should restate the document, not riff on it. */
const SUMMARY_TEMPERATURE = 0.1;

/**
 * Summarizes a single chunk of document text with relevance to the user's prompt.
 * A failure is returned rather than thrown, so one bad chunk does not sink
 * the batch; the caller decides whether enough of the document survived.
 *
 * @param complete - Completion function bound to the turn's chat model
 * @param prompt - The user's original prompt to guide relevance filtering
 * @param chunk - The text chunk to summarize
 * @param maxCompletionTokens - Maximum tokens for the completion response
 * @returns The chunk's summary (possibly empty when nothing is relevant), or the error
 */
async function summarizeChunk(
  complete: TextCompleter,
  prompt: string,
  chunk: string,
  maxCompletionTokens: number,
): Promise<ChunkSummaryResult> {
  const summaryPrompt: string = `Summarize the following text with relevance to the prompt, but keep enough details to maintain the tone, character, and content of the original. If nothing is relevant, then return an empty string:\n\n\`\`\`prompt\n${prompt}\`\`\`\n\n\`\`\`text\n${chunk}\n\`\`\``;

  try {
    const perfLlmStart = performance.now();
    const summary = await complete({
      systemPrompt: CHUNK_SUMMARY_SYSTEM_PROMPT,
      userPrompt: summaryPrompt,
      maxTokens: maxCompletionTokens,
      temperature: SUMMARY_TEMPERATURE,
    });
    console.log(
      `[Perf] summarizeChunk LLM call: ${(performance.now() - perfLlmStart).toFixed(1)}ms`,
    );
    return { ok: true, summary };
  } catch (error: unknown) {
    console.error('Error summarizing chunk:', sanitizeForLog(error));
    return { ok: false, error };
  }
}

/**
 * Condenses a document too large to inline into a summary of the content
 * relevant to the user's query, for the main chat model to answer from.
 *
 * 1. Loads the document (unless pre-extracted) and splits it into chunks
 *    sized to the model's context window and throughput.
 * 2. Summarizes the chunks in parallel batches.
 * 3. Asks the model for one consolidated, query-focused summary.
 *
 * Every call goes through `complete`, so the summary runs on the same model,
 * SDK and region (or custom-source account) as the chat answer itself.
 *
 * @param args - See {@link SummarizeDocumentArguments}
 * @returns The consolidated summary text (never empty)
 * @throws When every chunk failed (rethrowing the first failure, so the
 *         cause reaches the logs instead of an empty summary reaching the
 *         model), when the final completion fails, or when it comes back empty.
 */
export async function summarizeDocumentForQuery({
  file,
  prompt,
  modelId,
  complete,
  preExtractedText,
  onProgress,
  servingTokensPerMinute,
}: SummarizeDocumentArguments): Promise<string> {
  console.log(
    '[summarizeDocumentForQuery] Starting with file:',
    sanitizeForLog(file.name),
    'size:',
    sanitizeForLog(file.size),
  );
  console.log(
    '[summarizeDocumentForQuery] Prompt length:',
    sanitizeForLog(prompt.length),
  );

  const perfTotalStart = performance.now();

  // Use pre-extracted text if provided, otherwise load document
  const perfLoadStart = performance.now();
  const fileContent = preExtractedText ?? (await loadDocument(file));
  console.log(
    `[Perf] summarizeDocumentForQuery.loadContent: ${(performance.now() - perfLoadStart).toFixed(1)}ms (${preExtractedText ? 'pre-extracted' : 'loaded from file'})`,
  );
  console.log(
    '[summarizeDocumentForQuery] File content loaded, length:',
    fileContent.length,
  );

  // Get model configuration for dynamic chunk sizing using direct key access
  console.log('[summarizeDocumentForQuery] Looking up model:', modelId);
  const catalogConfig = OpenAIModels[modelId as OpenAIModelID];
  const modelConfig = catalogConfig
    ? applyAdmissionCeiling(catalogConfig, servingTokensPerMinute)
    : undefined;
  if (!modelConfig) {
    console.log(
      '[summarizeDocumentForQuery] Model not found in OpenAIModels, using defaults',
    );
  }

  // Estimate chars per token based on content script type
  const charsPerToken = estimateCharsPerToken(fileContent);
  console.log(
    '[summarizeDocumentForQuery] Estimated chars per token:',
    charsPerToken,
  );

  const chunkConfig = calculateChunkConfig(modelConfig, charsPerToken);

  const perfChunkStart = performance.now();
  const chunks: string[] = splitIntoChunks(fileContent, chunkConfig.chunkSize);
  console.log(
    `[Perf] summarizeDocumentForQuery.splitIntoChunks: ${(performance.now() - perfChunkStart).toFixed(1)}ms (${chunks.length} chunks)`,
  );
  console.log(
    '[summarizeDocumentForQuery] Split into chunks:',
    chunks.length,
    'chunk size:',
    chunkConfig.chunkSize,
  );

  let combinedSummary: string = '';
  let processedChunkCount = 0;
  let firstChunkError: unknown;
  const totalChunks = chunks.length;
  let attemptedChunkCount = 0;

  while (chunks.length > 0) {
    const currentChunks = chunks.splice(0, chunkConfig.batchSize);
    console.log(
      `[summarizeDocumentForQuery] Processing batch of ${currentChunks.length} chunks, ${chunks.length} remaining`,
    );

    const perfBatchStart = performance.now();
    const results = await Promise.all(
      currentChunks.map((chunk) =>
        summarizeChunk(
          complete,
          prompt,
          chunk,
          chunkConfig.maxCompletionTokens,
        ),
      ),
    );
    console.log(
      `[Perf] summarizeDocumentForQuery.batch: ${(performance.now() - perfBatchStart).toFixed(1)}ms (${currentChunks.length} chunks)`,
    );

    const validSummaries: string[] = [];
    for (const result of results) {
      if (result.ok) validSummaries.push(result.summary);
      else if (firstChunkError === undefined) firstChunkError = result.error;
    }
    console.log(
      '[summarizeDocumentForQuery] Batch completed, summaries received:',
      validSummaries.length,
    );

    processedChunkCount += validSummaries.length;
    // Progress counts attempts (not successes) so a failed chunk still moves
    // the loader instead of stalling it.
    attemptedChunkCount += currentChunks.length;
    onProgress?.(attemptedChunkCount, totalChunks);

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
    '[summarizeDocumentForQuery] Summarization complete, processed chunks:',
    processedChunkCount,
    'combined summary length:',
    combinedSummary.length,
  );

  // Nothing of the document survived: a final call would only summarize an
  // empty string. Surface the real cause (deployment missing, auth, ...).
  if (totalChunks > 0 && processedChunkCount === 0) {
    throw firstChunkError instanceof Error
      ? firstChunkError
      : new Error(
          `Every chunk of the document failed to summarize: ${String(firstChunkError)}`,
        );
  }

  const finalPrompt = `${combinedSummary}\n\nThe user's query is: "${prompt}"\n\nProduce a comprehensive summary of the document content that is relevant to the user's query. Include key details, data, and context. Do NOT answer the query directly — just extract and organize the relevant content.`;

  // Never grounded on a knowledge base here. Knowledge-base agents get their
  // index search from RAGEnricher, which runs after this summary is built and
  // injects both into the final request. (The Azure "On Your Data"
  // data_sources grounding this used to send has been retired by Azure.)
  const perfFinalLlmStart = performance.now();
  const completionText = await complete({
    systemPrompt: FINAL_SUMMARY_SYSTEM_PROMPT,
    userPrompt: finalPrompt,
    maxTokens: chunkConfig.maxCompletionTokens,
    temperature: SUMMARY_TEMPERATURE,
  });
  console.log(
    `[Perf] summarizeDocumentForQuery.finalCompletion: ${(performance.now() - perfFinalLlmStart).toFixed(1)}ms`,
  );
  console.log(
    `[Perf] summarizeDocumentForQuery total: ${(performance.now() - perfTotalStart).toFixed(1)}ms`,
  );

  if (!completionText) {
    throw new Error(
      `The model returned an empty document summary for ${sanitizeForLog(file.name)}`,
    );
  }
  return completionText;
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
