import { parseAndQueryFileOpenAI } from '@/lib/utils/app/stream/documentSummary';
import { sanitizeForLog } from '@/lib/utils/server/logSanitization';

import { TranscriptionServiceFactory } from '../../transcriptionService';
import { FileProcessingService } from '../FileProcessingService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import { InputValidator } from '../validators/InputValidator';

import { isAudioVideoFile } from '@/lib/constants/fileTypes';
import { SpanStatusCode, trace } from '@opentelemetry/api';

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

          const transcripts: Array<{
            filename: string;
            transcript: string;
          }> = [];

          // Extract files and images from message
          const files: Array<{ url: string; originalFilename?: string }> = [];
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

                const transcriptionService =
                  TranscriptionServiceFactory.getTranscriptionService(
                    'whisper',
                  );
                const transcript =
                  await transcriptionService.transcribe(filePath);

                transcripts.push({
                  filename,
                  transcript,
                });

                console.log(
                  `[FileProcessor] Transcription complete: ${transcript.length} chars`,
                );
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

                // Process with parseAndQueryFileOpenAI
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

          // Add span attributes
          span.setAttribute('file.count', files.length);
          span.setAttribute('file.summaries_count', fileSummaries.length);
          span.setAttribute('file.transcripts_count', transcripts.length);
          span.setAttribute('file.images_count', images.length);
          span.setStatus({ code: SpanStatusCode.OK });

          // Return context with processed content
          return {
            ...context,
            processedContent: {
              ...context.processedContent,
              fileSummaries:
                fileSummaries.length > 0 ? fileSummaries : undefined,
              transcripts: transcripts.length > 0 ? transcripts : undefined,
              images: images.length > 0 ? images : undefined,
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
