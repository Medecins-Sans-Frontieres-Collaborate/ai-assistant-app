import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { FileProcessingService } from '@/lib/services/chat';
import { guardTranscriptionMinutes } from '@/lib/services/limits/transcriptionBudget';
import { getAzureMonitorLogger } from '@/lib/services/observability';

import { FILE_SIZE_LIMITS, WHISPER_MAX_SIZE } from '@/lib/utils/app/const';
import {
  calculateChunkConfig,
  estimateCharsPerToken,
  parseAndQueryFileOpenAI,
} from '@/lib/utils/app/stream/documentSummary';
import {
  extractAudioFromVideo,
  isFFmpegAvailable,
} from '@/lib/utils/server/audio/audioExtractor';
import { BlobStorage, getBlobBase64String } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';
import { validateBufferSignature } from '@/lib/utils/server/file/fileValidation';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message, TextMessageContent } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { getChunkedTranscriptionService } from '../../transcription/chunkedTranscriptionService';
import { TranscriptionServiceFactory } from '../../transcriptionService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import {
  InputValidator,
  expiredFilePipelineError,
} from '../validators/InputValidator';

import {
  isAudioVideoFile,
  isWhisperNativeFormat,
} from '@/lib/constants/fileTypes';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import fs from 'fs';
import { performance } from 'perf_hooks';

// Note: Synchronous polling was removed in favor of async client-side polling.
// Batch transcription jobs are now submitted and returned immediately with pending state.
// The frontend polls /api/transcription/status/[jobId] and updates the message when complete.

/**
 * FileProcessor handles file content processing in the pipeline.
 *
 * Responsibilities:
 * - Validates file sizes before download (prevents OOM)
 * - Downloads files from blob storage
 * - Extracts and processes file content
 * - Handles audio/video transcription
 * - Summarizes documents
 * - Passes images through if present (for mixed content)
 *
 * Modifies context:
 * - context.processedContent.fileSummaries
 * - context.processedContent.transcripts
 * - context.processedContent.images (passes through)
 */
export class FileProcessor extends BasePipelineStage {
  readonly name = 'FileProcessor';
  private tracer = trace.getTracer('file-processor');

  constructor(
    private fileProcessingService: FileProcessingService,
    private inputValidator: InputValidator,
    private blobStorageClient?: BlobStorage,
  ) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    // Also runs on follow-up turns whose LAST message has no attachment but
    // an earlier user message does — otherwise the document context
    // evaporates after the upload turn and the model asks the user to
    // re-upload a file it was just discussing.
    return (
      context.hasFiles ||
      FileProcessor.findLatestDocumentMessage(context.messages) !== null
    );
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return await this.tracer.startActiveSpan(
      'file.process',
      {
        attributes: {
          'user.id': context.user.id,
          'model.id': context.modelId,
        },
      },
      async (span) => {
        // Every downloaded temp file is registered here the moment its path
        // is reserved (before the download starts), so the finally below can
        // clean up partial downloads too. Cleanup must not depend on the
        // happy path: a single failing file used to skip cleanup entirely
        // and strand multi-GB downloads in /tmp.
        const tempFilePaths: string[] = [];
        try {
          const perfStart = performance.now();
          const lastMessage = context.messages[context.messages.length - 1];

          // Upload turns carry attachments on the last message; follow-up
          // turns ("now actually do it") do not — fall back to the most
          // recent user message with document attachments so file context
          // survives the whole conversation. Walk-back deliberately skips
          // audio/video below: re-transcribing on every follow-up would be
          // prohibitively expensive, and finished transcripts already live
          // in the conversation text.
          const sourceMessage = context.hasFiles
            ? lastMessage
            : FileProcessor.findLatestDocumentMessage(context.messages);
          if (!sourceMessage) {
            console.log(
              '[FileProcessor] No message with attachments found; skipping',
            );
            return context;
          }
          const isWalkBack = sourceMessage !== lastMessage;

          if (!Array.isArray(sourceMessage.content)) {
            throw new Error('Expected array content for file processing');
          }

          const fileSummaries: Array<{
            filename: string;
            summary: string;
            originalContent: string;
          }> = [];

          const inlineFiles: Array<{
            filename: string;
            content: string;
          }> = [];

          const transcripts: Array<{
            filename: string;
            transcript: string;
          }> = [];

          // Extract files and images from message
          const files: Array<{
            url: string;
            originalFilename?: string;
            transcriptionLanguage?: string;
            transcriptionPrompt?: string;
          }> = [];
          const images: Array<{
            url: string;
            detail: 'auto' | 'low' | 'high';
          }> = [];
          let prompt = '';

          for (const section of sourceMessage.content) {
            if (section.type === 'text') {
              prompt = section.text;
            } else if (section.type === 'file_url') {
              if (
                isWalkBack &&
                isAudioVideoFile(section.originalFilename || section.url)
              ) {
                continue;
              }
              files.push({
                url: section.url,
                originalFilename: section.originalFilename,
                transcriptionLanguage: section.transcriptionLanguage,
                transcriptionPrompt: section.transcriptionPrompt,
              });
            } else if (section.type === 'image_url') {
              // Prior-turn images stay ImageProcessor/last-message territory.
              if (!isWalkBack) {
                images.push({
                  url: section.image_url.url,
                  detail: section.image_url.detail || 'auto',
                });
              }
            }
          }

          // The guiding prompt must be the CURRENT request ("please do it"),
          // not whatever accompanied the original upload.
          if (isWalkBack) {
            prompt = FileProcessor.extractPromptText(lastMessage) || prompt;
          }

          if (isWalkBack && files.length > 0) {
            console.log(
              `[FileProcessor] Follow-up turn: re-processing ${files.length} attachment(s) from an earlier message`,
            );
          }

          console.log(
            `[FileProcessor] Processing ${files.length} file(s), ${images.length} image(s)`,
          );

          // STEP 1: Validate all file sizes in parallel (I/O bound)
          console.log(`[FileProcessor] Validating file sizes...`);
          const perfValidateStart = performance.now();
          await Promise.all(
            files.map((file) =>
              this.inputValidator.validateFileSize(
                file.url,
                context.user,
                (url, user) =>
                  this.fileProcessingService.getFileSize(url, user),
              ),
            ),
          );
          console.log(
            `[Perf] FileProcessor.validateFileSizes: ${(performance.now() - perfValidateStart).toFixed(1)}ms`,
          );

          // STEP 2: Download all files in parallel (I/O bound)
          console.log(
            `[FileProcessor] Downloading ${files.length} file(s) in parallel...`,
          );
          const downloadedFiles = await Promise.all(
            files.map(async (file) => {
              const [blobId, filePath] =
                this.fileProcessingService.getTempFilePath(file.url);
              const filename = file.originalFilename || blobId;

              // Register before downloading so a failed/partial download is
              // still cleaned up by the finally block.
              tempFilePaths.push(filePath);

              console.log(
                `[FileProcessor] File data:`,
                JSON.stringify({
                  url: file.url,
                  originalFilename: file.originalFilename,
                  hasOriginalFilename: !!file.originalFilename,
                  blobId,
                  finalFilename: filename,
                }),
              );

              // Download file. A blob deleted between the size validation
              // above and this GET still surfaces as the distinct
              // expired-file error, not an opaque failure.
              const perfDownloadStart = performance.now();
              try {
                await this.fileProcessingService.downloadFile(
                  file.url,
                  filePath,
                  context.user,
                );
              } catch (downloadError) {
                if (isBlobNotFoundError(downloadError)) {
                  throw expiredFilePipelineError(file.url, downloadError);
                }
                throw downloadError;
              }
              console.log(
                `[Perf] FileProcessor.downloadFile "${sanitizeForLog(filename)}": ${(performance.now() - perfDownloadStart).toFixed(1)}ms`,
              );
              console.log(
                `[FileProcessor] Downloaded: ${sanitizeForLog(filename)}`,
              );

              // Read file into buffer
              const perfReadStart = performance.now();
              const fileBuffer =
                await this.fileProcessingService.readFile(filePath);
              console.log(
                `[Perf] FileProcessor.readFile "${sanitizeForLog(filename)}": ${(performance.now() - perfReadStart).toFixed(1)}ms`,
              );

              return {
                file,
                filename,
                filePath,
                fileBuffer,
              };
            }),
          );

          // STEP 3: Process files sequentially (CPU/API bound - avoid rate limiting)
          console.log(`[FileProcessor] Processing files sequentially...`);
          for (const {
            file,
            filename,
            filePath,
            fileBuffer,
          } of downloadedFiles) {
            try {
              // Check if audio/video
              if (isAudioVideoFile(filename)) {
                console.log(
                  `[FileProcessor] Transcribing audio/video: ${sanitizeForLog(filename)}`,
                );

                // Determine if this is a video file that needs audio extraction
                const validation = validateBufferSignature(
                  fileBuffer,
                  'any',
                  filename,
                );
                const isVideo = validation.detectedType === 'video';

                // Whisper natively accepts only mp3/mp4/mpeg/mpga/m4a/wav/webm.
                // Any other accepted container (video OR non-Whisper-native audio
                // like ogg/flac/aac/opus) must be transcoded to mp3 via FFmpeg
                // first. Issue #90: .m4v previously fell through to the document
                // branch because it wasn't in the allowlist; now it reaches here
                // but still needs extraction (Whisper doesn't accept m4v).
                const needsExtraction =
                  isVideo || !isWhisperNativeFormat(filename);

                // Get original file size for logging
                const originalStats = await fs.promises.stat(filePath);
                const originalSizeMB = (
                  originalStats.size /
                  (1024 * 1024)
                ).toFixed(1);

                console.log(
                  `[FileProcessor] Original file size: ${originalSizeMB}MB, type: ${validation.detectedType || 'unknown'}, needsExtraction: ${needsExtraction}`,
                );

                let fileToTranscribe = filePath;
                let extractedAudioPath: string | null = null;

                // Extract audio from video files before transcription
                if (needsExtraction) {
                  // Check FFmpeg availability before attempting extraction
                  const ffmpegAvailable = await isFFmpegAvailable();
                  if (!ffmpegAvailable) {
                    // Format-neutral wording: non-Whisper-native audio (ogg,
                    // flac, aac, opus, …) hits this branch too, not just video.
                    throw new Error(
                      `Cannot process file "${filename}": FFmpeg is not available. ` +
                        `Please configure the FFMPEG_BIN environment variable or install FFmpeg.`,
                    );
                  }

                  console.log(
                    `[FileProcessor] Detected ${isVideo ? 'video' : 'non-Whisper-native audio'} file, extracting audio: ${sanitizeForLog(filename)}`,
                  );
                  try {
                    const extraction = await extractAudioFromVideo(filePath);
                    fileToTranscribe = extraction.outputPath;
                    extractedAudioPath = extraction.outputPath;

                    // Log extracted audio size
                    const extractedStats =
                      await fs.promises.stat(extractedAudioPath);
                    const extractedSizeMB = (
                      extractedStats.size /
                      (1024 * 1024)
                    ).toFixed(1);

                    console.log(
                      `[FileProcessor] Audio extracted to: ${extractedAudioPath}`,
                    );
                    console.log(
                      `[FileProcessor] Extracted audio size: ${extractedSizeMB}MB (video was ${originalSizeMB}MB)`,
                    );
                  } catch (extractionError) {
                    // For video files, extraction is REQUIRED - can't send video to batch transcription
                    // Azure Batch Transcription only accepts audio files, not video containers
                    console.error(
                      `[FileProcessor] Audio extraction FAILED for ${sanitizeForLog(filename)}:`,
                      extractionError,
                    );

                    // Preserve user-friendly error messages from audio extraction
                    const originalMessage =
                      extractionError instanceof Error
                        ? extractionError.message
                        : String(extractionError);

                    // Check for known user-friendly error patterns that should be surfaced
                    const isUserFriendlyError =
                      originalMessage.includes(
                        'does not contain an audio track',
                      ) || originalMessage.includes('FFmpeg is not available');

                    if (isUserFriendlyError) {
                      throw new Error(originalMessage);
                    }

                    // Fallback to generic message for unknown errors
                    throw new Error(
                      `Cannot transcribe video file "${filename}": Audio extraction failed. ` +
                        `Please ensure FFmpeg is properly installed, or try uploading an audio file instead.`,
                    );
                  }
                }

                try {
                  // Get file size to determine transcription service (extracted audio or original)
                  const stats = await fs.promises.stat(fileToTranscribe);
                  const audioSize = stats.size;
                  const audioSizeMB = (audioSize / (1024 * 1024)).toFixed(1);

                  console.log(
                    `[FileProcessor] File to transcribe size: ${audioSizeMB}MB${extractedAudioPath ? ' (extracted audio)' : ' (original file)'}`,
                  );

                  if (audioSize > FILE_SIZE_LIMITS.VIDEO_MAX_BYTES) {
                    // VIDEO_MAX_BYTES (1.5GB) is the defense-in-depth upper
                    // bound for this path — the upload route applies the
                    // per-type caps (1GB audio / 1.5GB video) before we get
                    // here. Hitting this branch means either pre-upload
                    // validation was bypassed or extracted audio unexpectedly
                    // exceeded the ceiling; either way, the user-facing
                    // message stays generic.
                    throw new Error(
                      `File "${filename}" (${audioSizeMB}MB) is too large to transcribe.`,
                    );
                  }

                  // Usage limit: transcription minutes per day
                  // (`feature.transcription.minutesPerDay`, docs/LIMITS.md).
                  // Measured BEFORE any transcription work, using the existing
                  // ffprobe helper — duration is the honest unit here, since a
                  // 5-minute lossless file and a 5-minute compressed one cost
                  // the same to transcribe but differ wildly in bytes.
                  //
                  // Rounded UP to whole minutes: a limit of 60 must not be
                  // circumvented by 120 requests of 30 seconds each.
                  const transcriptionGuard = await guardTranscriptionMinutes(
                    context.session,
                    fileToTranscribe,
                  );
                  if (!transcriptionGuard.allowed) {
                    throw new Error(
                      transcriptionGuard.message ??
                        `Transcription limit reached. "${filename}" was not transcribed.`,
                    );
                  }

                  let transcript: string;

                  // Route based on file size: ≤25MB → Whisper, >25MB → Batch
                  if (audioSize <= WHISPER_MAX_SIZE) {
                    // Whisper transcription (synchronous, ≤25MB)
                    console.log(
                      `[FileProcessor] Using Whisper transcription (≤25MB)`,
                    );

                    const transcriptionService =
                      TranscriptionServiceFactory.getTranscriptionService(
                        'whisper',
                      );

                    // Pass transcription options (language and prompt) if specified
                    const transcriptionOptions = {
                      language: file.transcriptionLanguage,
                      prompt: file.transcriptionPrompt,
                    };

                    transcript = await transcriptionService.transcribe(
                      fileToTranscribe,
                      transcriptionOptions,
                    );

                    // Whisper completed synchronously - add transcript immediately
                    transcripts.push({
                      filename,
                      transcript,
                    });

                    // Log successful transcription (fire-and-forget)
                    const logger = getAzureMonitorLogger();
                    void logger.logTranscriptionSuccess({
                      user: context.user,
                      filename,
                      fileSize: audioSize,
                      transcriptionType: 'whisper',
                      language: file.transcriptionLanguage,
                    });

                    console.log(
                      `[FileProcessor] Transcription complete: ${transcript.length} chars`,
                    );
                  } else {
                    // Chunked transcription (asynchronous with polling, >25MB)
                    // Splits large files into smaller chunks and transcribes each
                    console.log(
                      `[FileProcessor] Using Chunked transcription (>25MB)`,
                    );

                    // Check if chunked transcription service is available
                    const chunkedService = getChunkedTranscriptionService();
                    if (!chunkedService.isAvailable()) {
                      throw new Error(
                        `Audio file (${audioSizeMB}MB) exceeds 25MB Whisper limit. ` +
                          `Chunked transcription is not available - FFmpeg/FFprobe not found.`,
                      );
                    }

                    console.log(
                      `[FileProcessor] Starting chunked transcription job...`,
                    );

                    // Start chunked transcription job (returns immediately).
                    // Job state lives in the user's regional storage account,
                    // so the store client must be session-scoped.
                    const { jobId, totalChunks } =
                      await chunkedService.startJob(
                        createBlobStorageClient(context.session),
                        fileToTranscribe,
                        filename,
                        context.user.id,
                        {
                          language: file.transcriptionLanguage,
                          prompt: file.transcriptionPrompt,
                        },
                      );

                    console.log(
                      `[FileProcessor] Chunked job submitted: ${jobId} (${totalChunks} chunks)`,
                    );

                    // Store pending transcription info (async - client will poll)
                    if (!context.processedContent) {
                      context.processedContent = {};
                    }
                    if (!context.processedContent.pendingTranscriptions) {
                      context.processedContent.pendingTranscriptions = [];
                    }
                    context.processedContent.pendingTranscriptions.push({
                      filename,
                      jobId,
                      totalChunks,
                      jobType: 'chunked',
                    });

                    // Add placeholder transcript for UI display
                    transcripts.push({
                      filename,
                      transcript: `[Transcription in progress: ${filename}]`,
                    });

                    // Log chunked transcription job queued (fire-and-forget)
                    // Note: Final success/error will be logged when the job completes
                    const chunkedLogger = getAzureMonitorLogger();
                    void chunkedLogger.logTranscriptionQueued({
                      user: context.user,
                      filename,
                      fileSize: audioSize,
                      jobId,
                      totalChunks,
                      language: file.transcriptionLanguage,
                    });

                    console.log(
                      `[FileProcessor] Chunked transcription job queued for async processing: ${jobId}`,
                    );
                  }
                } finally {
                  // Clean up extracted audio file if created
                  if (extractedAudioPath) {
                    try {
                      await this.fileProcessingService.cleanupFile(
                        extractedAudioPath,
                      );
                      console.log(
                        `[FileProcessor] Cleaned up extracted audio: ${extractedAudioPath}`,
                      );
                    } catch (cleanupError) {
                      console.warn(
                        `[FileProcessor] Failed to clean up extracted audio:`,
                        cleanupError,
                      );
                    }
                  }
                }
              } else {
                // Regular document processing
                console.log(
                  `[FileProcessor] Processing document: ${sanitizeForLog(filename)}`,
                );

                // Extraction of a multi-MB document takes seconds — tell the
                // client what is happening instead of a generic "Thinking…".
                void context.emitActivity?.('chat.activity.readingDocument', {
                  filename: FileProcessor.truncateName(filename),
                });

                const docFile = new File(
                  [new Uint8Array(fileBuffer)],
                  filename,
                  {},
                );

                // Extract text first to determine if small-file inline path applies
                const perfLoadDocStart = performance.now();
                const text = await loadDocument(docFile);
                console.log(
                  `[Perf] FileProcessor.loadDocument "${sanitizeForLog(filename)}": ${(performance.now() - perfLoadDocStart).toFixed(1)}ms`,
                );

                // Calculate chunk threshold for this model/content
                const modelConfig =
                  OpenAIModels[context.modelId as OpenAIModelID];
                const charsPerToken = estimateCharsPerToken(text);
                const { chunkSize } = calculateChunkConfig(
                  modelConfig,
                  charsPerToken,
                );

                if (text.length <= chunkSize) {
                  // Small file: skip summarization, include raw content inline
                  console.log(
                    `[FileProcessor] Small file (${text.length} chars <= ${chunkSize} chunk size), inlining: ${sanitizeForLog(filename)}`,
                  );
                  inlineFiles.push({ filename, content: text });
                } else {
                  // Large file: use chunking/summarization pipeline
                  console.log(
                    `[FileProcessor] Large file (${text.length} chars > ${chunkSize} chunk size), summarizing: ${sanitizeForLog(filename)}`,
                  );

                  // A large document means dozens of sequential summarization
                  // batches (minutes of otherwise-silent wall clock). Emit a
                  // starting marker now and per-batch progress below.
                  void context.emitActivity?.(
                    'chat.activity.condensingDocument',
                    {
                      filename: FileProcessor.truncateName(filename),
                      percent: '0',
                    },
                  );

                  // Process with parseAndQueryFileOpenAI, passing pre-extracted text
                  // Note: We get the summary as a string (non-streaming for pipeline)
                  // Note: Images are NOT passed here - they remain in the message for the final chat
                  const perfSummaryStart = performance.now();
                  const summary = await parseAndQueryFileOpenAI({
                    file: docFile,
                    prompt: prompt || 'Summarize this document',
                    modelId: context.modelId,
                    user: context.user,
                    // Prompt/M365 agents arrive via botId but must never
                    // trigger a knowledge-base search (mirrors RAGEnricher):
                    // a truthy botId turns the summarization into an Azure
                    // "On Your Data" request grounded on the org KB index.
                    botId:
                      context.promptAgent || context.m365Agent
                        ? undefined
                        : context.botId,
                    stream: false,
                    // Don't pass images - blob URLs aren't accessible to Azure OpenAI during summarization
                    // Images will be included in the final message content by StandardChatHandler
                    images: undefined,
                    preExtractedText: text,
                    onProgress: (processed, total) => {
                      void context.emitActivity?.(
                        'chat.activity.condensingDocument',
                        {
                          filename: FileProcessor.truncateName(filename),
                          percent: String(
                            Math.min(
                              100,
                              Math.round((processed / total) * 100),
                            ),
                          ),
                        },
                      );
                    },
                  });
                  console.log(
                    `[Perf] FileProcessor.parseAndQueryFileOpenAI "${sanitizeForLog(filename)}": ${(performance.now() - perfSummaryStart).toFixed(1)}ms`,
                  );

                  if (typeof summary !== 'string') {
                    throw new Error(
                      'Expected string summary from parseAndQueryFileOpenAI',
                    );
                  }

                  fileSummaries.push({
                    filename,
                    summary,
                    originalContent: fileBuffer.toString('utf-8', 0, 1000), // First 1000 chars
                  });
                }

                console.log(
                  `[FileProcessor] Document processed: ${sanitizeForLog(filename)}`,
                );
              }
            } catch (error) {
              // Log processing error but continue with other files
              console.error(
                `[FileProcessor] Error processing ${sanitizeForLog(filename)}:`,
                error,
              );

              // Log transcription/file processing error (fire-and-forget)
              const errorLogger = getAzureMonitorLogger();
              const isTranscriptionError = isAudioVideoFile(filename);
              if (isTranscriptionError) {
                void errorLogger.logTranscriptionError({
                  user: context.user,
                  filename,
                  transcriptionType: 'unknown',
                  errorCode: 'TRANSCRIPTION_FAILED',
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                });
              } else {
                void errorLogger.logFileError({
                  user: context.user,
                  filename,
                  errorCode: 'FILE_PROCESSING_FAILED',
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                });
              }

              // Re-throw to be caught by BasePipelineStage error handling
              throw error;
            }
          }

          // STEP 4 (temp-file cleanup) now lives in the finally block below
          // so it also runs when any file fails processing.

          // STEP 5: Convert images to base64 for LLM consumption
          // Uses getBlobBase64String which handles both data URL strings and binary content
          let convertedImages = images;
          if (images.length > 0) {
            console.log(
              `[FileProcessor] Converting ${images.length} image(s) to base64...`,
            );
            const perfImgStart = performance.now();
            convertedImages = await Promise.all(
              images.map(async (image) => {
                // Skip if already a base64 data URL
                if (image.url.startsWith('data:')) {
                  return image;
                }

                // Extract filename from URL (works for both /api/file/{id} and blob URLs)
                const filename = image.url.split('/').pop() || image.url;
                const base64Url = await getBlobBase64String(
                  context.user.id ?? 'anonymous',
                  filename,
                  'images',
                  context.user,
                );
                return { url: base64Url, detail: image.detail };
              }),
            );
            console.log(
              `[Perf] FileProcessor.imageBase64Conversion: ${(performance.now() - perfImgStart).toFixed(1)}ms (${images.length} images)`,
            );
            console.log(
              `[FileProcessor] Converted ${convertedImages.length} image(s) to base64`,
            );
          }

          // Add span attributes
          span.setAttribute('file.count', files.length);
          span.setAttribute('file.summaries_count', fileSummaries.length);
          span.setAttribute('file.inline_files_count', inlineFiles.length);
          span.setAttribute('file.transcripts_count', transcripts.length);
          span.setAttribute('file.images_count', convertedImages.length);
          span.setStatus({ code: SpanStatusCode.OK });

          console.log(
            `[Perf] FileProcessor.processFiles total: ${(performance.now() - perfStart).toFixed(1)}ms (${files.length} files, ${images.length} images)`,
          );

          // Return context with processed content
          return {
            ...context,
            processedContent: {
              ...context.processedContent,
              fileSummaries:
                fileSummaries.length > 0 ? fileSummaries : undefined,
              inlineFiles: inlineFiles.length > 0 ? inlineFiles : undefined,
              transcripts: transcripts.length > 0 ? transcripts : undefined,
              images: convertedImages.length > 0 ? convertedImages : undefined,
            },
          };
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          // Best-effort cleanup of every downloaded temp file — success and
          // failure paths alike. /tmp also hosts the chunked job store and
          // chunk dirs, so stranded downloads here can starve the whole
          // transcription pipeline of disk.
          if (tempFilePaths.length > 0) {
            const perfCleanupStart = performance.now();
            const outcomes = await Promise.allSettled(
              tempFilePaths.map((p) =>
                this.fileProcessingService.cleanupFile(p),
              ),
            );
            const failed = outcomes.filter(
              (o) => o.status === 'rejected',
            ).length;
            if (failed > 0) {
              console.warn(
                `[FileProcessor] Failed to clean up ${failed}/${tempFilePaths.length} temp file(s)`,
              );
            }
            console.log(
              `[Perf] FileProcessor.cleanupTempFiles: ${(performance.now() - perfCleanupStart).toFixed(1)}ms (${tempFilePaths.length} files)`,
            );
          }
          span.end();
        }
      },
    );
  }

  /** Keeps filenames loader-friendly: the marker renders in a one-line pill. */
  private static truncateName(filename: string): string {
    const MAX = 40;
    return filename.length > MAX ? `${filename.slice(0, MAX - 1)}…` : filename;
  }

  /** Most recent user message carrying a document (file_url) attachment. */
  private static findLatestDocumentMessage(
    messages: Message[],
  ): Message | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'user' || !Array.isArray(message.content)) continue;
      if (message.content.some((section) => section.type === 'file_url')) {
        return message;
      }
    }
    return null;
  }

  /** Text of a message whose content may be a string or a parts array. */
  private static extractPromptText(message: Message): string {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content.find(
        (section) => section.type === 'text',
      ) as TextMessageContent | undefined;
      return text?.text ?? '';
    }
    return '';
  }
}
