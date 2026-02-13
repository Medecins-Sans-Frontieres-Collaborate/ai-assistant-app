/**
 * CodeInterpreterEnricher
 *
 * Enriches the pipeline for Code Interpreter execution.
 *
 * Responsibilities:
 * - Detects when Code Interpreter should be used (model flag + file presence)
 * - Downloads files from blob storage
 * - Uploads files to AI Foundry for Code Interpreter use
 * - Sets execution strategy to 'code_interpreter'
 * - Injects file context into user message
 */
import { FileMessageContent } from '@/types/chat';
import { isCodeInterpreterSupported } from '@/types/codeInterpreter';

import { FileProcessingService } from '../FileProcessingService';
import { CodeInterpreterFileService } from '../codeInterpreter/CodeInterpreterFileService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * CodeInterpreterEnricher prepares files for Code Interpreter execution.
 *
 * Runs when:
 * - Model has codeInterpreter=true
 * - Files are present in the message
 * - At least one file is supported by Code Interpreter
 *
 * Modifies context:
 * - context.codeInterpreterFiles (uploaded file IDs)
 * - context.executionStrategy = 'code_interpreter'
 * - context.enrichedMessages (with file context injected)
 */
export class CodeInterpreterEnricher extends BasePipelineStage {
  readonly name = 'CodeInterpreterEnricher';
  private tracer = trace.getTracer('code-interpreter-enricher');

  constructor(
    private codeInterpreterFileService: CodeInterpreterFileService,
    private fileProcessingService: FileProcessingService,
  ) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    // Only run if model supports Code Interpreter
    if (!context.model.codeInterpreter) {
      return false;
    }

    // Only run if files are present
    if (!context.hasFiles) {
      return false;
    }

    // Check if at least one file is Code Interpreter compatible
    const lastMessage = context.messages[context.messages.length - 1];
    if (!Array.isArray(lastMessage.content)) {
      return false;
    }

    const hasCompatibleFile = lastMessage.content.some(
      (section) =>
        section.type === 'file_url' &&
        section.originalFilename &&
        isCodeInterpreterSupported(section.originalFilename),
    );

    return hasCompatibleFile;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return await this.tracer.startActiveSpan(
      'code_interpreter.enrich',
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
            throw new Error('Expected array content for Code Interpreter');
          }

          // Extract file URLs and filenames
          const files: Array<{
            url: string;
            filename: string;
          }> = [];
          let textContent = '';

          for (const section of lastMessage.content) {
            if (section.type === 'text') {
              textContent = section.text;
            } else if (section.type === 'file_url') {
              const fileContent = section as FileMessageContent;
              if (
                fileContent.originalFilename &&
                isCodeInterpreterSupported(fileContent.originalFilename)
              ) {
                files.push({
                  url: fileContent.url,
                  filename: fileContent.originalFilename,
                });
              }
            }
          }

          if (files.length === 0) {
            console.log(
              '[CodeInterpreterEnricher] No compatible files found, skipping',
            );
            return context;
          }

          console.log(
            `[CodeInterpreterEnricher] Uploading ${files.length} file(s) to AI Foundry`,
          );

          // Download files and upload to AI Foundry
          const uploadedFiles = await Promise.all(
            files.map(async (file) => {
              // Download file from blob storage
              const [blobId, filePath] =
                this.fileProcessingService.getTempFilePath(file.url);

              await this.fileProcessingService.downloadFile(
                file.url,
                filePath,
                context.user,
              );

              const buffer =
                await this.fileProcessingService.readFile(filePath);

              // Clean up temp file
              await this.fileProcessingService.cleanupFile(filePath);

              // Upload to AI Foundry
              const uploadedFile =
                await this.codeInterpreterFileService.uploadFile(
                  buffer,
                  file.filename,
                );

              return uploadedFile;
            }),
          );

          console.log(
            '[CodeInterpreterEnricher] Uploaded files:',
            uploadedFiles.map((f) => ({ id: f.id, filename: f.filename })),
          );

          // Inject file context into user message
          const fileContext = uploadedFiles
            .map((f) => `[Uploaded file: ${f.filename} (ID: ${f.id})]`)
            .join('\n');

          const enrichedContent = `${fileContext}\n\n${textContent}`;

          // Create enriched messages with file context
          const enrichedMessages = context.enrichedMessages
            ? [...context.enrichedMessages]
            : [...context.messages];

          // Update the last message to include file context
          const lastIndex = enrichedMessages.length - 1;
          const lastEnrichedMessage = { ...enrichedMessages[lastIndex] };

          // Replace the message content with enriched content
          // For Code Interpreter, we send text-only (files are attached via API)
          lastEnrichedMessage.content = enrichedContent;
          enrichedMessages[lastIndex] = lastEnrichedMessage;

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('files.uploaded', uploadedFiles.length);
          span.setAttribute(
            'files.ids',
            uploadedFiles.map((f) => f.id).join(','),
          );

          return {
            ...context,
            codeInterpreterFiles: uploadedFiles,
            executionStrategy: 'code_interpreter' as const,
            enrichedMessages,
          };
        } catch (error) {
          console.error('[CodeInterpreterEnricher] Error:', error);
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
