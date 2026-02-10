import { FileProcessingService } from '@/lib/services/chat';
import { getAzureMonitorLogger } from '@/lib/services/observability';

import { WHISPER_MAX_SIZE } from '@/lib/utils/app/const';
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
import { loadDocument } from '@/lib/utils/server/file/fileHandling';
import { validateBufferSignature } from '@/lib/utils/server/file/fileValidation';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { getChunkedTranscriptionService } from '../../transcription/chunkedTranscriptionService';
import { TranscriptionServiceFactory } from '../../transcriptionService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import { InputValidator } from '../validators/InputValidator';

import { isAudioVideoFile } from '@/lib/constants/fileTypes';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import fs from 'fs';

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
    return context.hasFiles;
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
        try {
          const lastMessage = context.messages[context.messages.length - 1];

          if (!Array.isArray(lastMessage.content)) {
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

          for (const section of lastMessage.content) {
            if (section.type === 'text') {
              prompt = section.text;
            } else if (section.type === 'file_url') {
              files.push({
                url: section.url,
                originalFilename: section.originalFilename,
                transcriptionLanguage: section.transcriptionLanguage,
                transcriptionPrompt: section.transcriptionPrompt,
              });
            } else if (section.type === 'image_url') {
              images.push({
                url: section.image_url.url,
                detail: section.image_url.detail || 'auto',
              });
            }
          }

          console.log(
            `[FileProcessor] Processing ${files.length} file(s), ${images.length} image(s)`,
          );

          // STEP 1: Validate all file sizes in parallel (I/O bound)
          console.log(`[FileProcessor] Validating file sizes...`);
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

          // STEP 2: Download all files in parallel (I/O bound)
          console.log(
            `[FileProcessor] Downloading ${files.length} file(s) in parallel...`,
          );
          const downloadedFiles = await Promise.all(
            files.map(async (file) => {
              const [blobId, filePath] =
                this.fileProcessingService.getTempFilePath(file.url);
              const filename = file.originalFilename || blobId;

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

              // Download file
              await this.fileProcessingService.downloadFile(
                file.url,
                filePath,
                context.user,
              );
              console.log(
                `[FileProcessor] Downloaded: ${sanitizeForLog(filename)}`,
              );

              // Read file into buffer
              const fileBuffer =
                await this.fileProcessingService.readFile(filePath);

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

                // Get original file size for logging
                const originalStats = await fs.promises.stat(filePath);
                const originalSizeMB = (
                  originalStats.size /
                  (1024 * 1024)
                ).toFixed(1);

                console.log(
                  `[FileProcessor] Original file size: ${originalSizeMB}MB, type: ${validation.detectedType || 'unknown'}`,
                );

                let fileToTranscribe = filePath;
                let extractedAudioPath: string | null = null;

                // Extract audio from video files before transcription
                if (isVideo) {
                  // Check FFmpeg availability before attempting extraction
                  const ffmpegAvailable = await isFFmpegAvailable();
                  if (!ffmpegAvailable) {
                    throw new Error(
                      `Cannot process video file "${filename}": FFmpeg is not available. ` +
                        `Please configure the FFMPEG_BIN environment variable or install FFmpeg.`,
                    );
                  }

                  console.log(
                    `[FileProcessor] Detected video file, extracting audio: ${sanitizeForLog(filename)}`,
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

                    // Start chunked transcription job (returns immediately)
                    const { jobId, totalChunks } =
                      await chunkedService.startJob(
                        fileToTranscribe,
                        filename,
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

                const docFile = new File(
                  [new Uint8Array(fileBuffer)],
                  filename,
                  {},
                );

                // Extract text first to determine if small-file inline path applies
                const text = await loadDocument(docFile);

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

                  // Process with parseAndQueryFileOpenAI, passing pre-extracted text
                  // Note: We get the summary as a string (non-streaming for pipeline)
                  // Note: Images are NOT passed here - they remain in the message for the final chat
                  const summary = await parseAndQueryFileOpenAI({
                    file: docFile,
                    prompt: prompt || 'Summarize this document',
                    modelId: context.modelId,
                    user: context.user,
                    botId: context.botId,
                    stream: false,
                    // Don't pass images - blob URLs aren't accessible to Azure OpenAI during summarization
                    // Images will be included in the final message content by StandardChatHandler
                    images: undefined,
                    preExtractedText: text,
                  });

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

          // STEP 4: Cleanup all temp files in parallel (I/O bound)
          console.log(
            `[FileProcessor] Cleaning up ${downloadedFiles.length} temp file(s)...`,
          );
          await Promise.all(
            downloadedFiles.map(({ filePath }) =>
              this.fileProcessingService.cleanupFile(filePath),
            ),
          );

          // STEP 5: Convert images to base64 for LLM consumption
          // Uses getBlobBase64String which handles both data URL strings and binary content
          let convertedImages = images;
          if (images.length > 0) {
            console.log(
              `[FileProcessor] Converting ${images.length} image(s) to base64...`,
            );
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
          span.end();
        }
      },
    );
  }
}
