/**
 * AgentEnricher
 *
 * Enriches the pipeline for AI Foundry agent execution.
 *
 * Responsibilities:
 * - Detects when to use AI Foundry agents
 * - Handles agent capabilities (Code Interpreter, Bing grounding)
 * - Uploads files to AI Foundry when Code Interpreter is enabled
 * - Sets execution strategy to 'agent'
 *
 * Key Design Decision:
 * Code Interpreter is treated as an agent CAPABILITY, not a separate
 * execution path. This enricher handles both standard agents (Bing grounding)
 * and agents with Code Interpreter enabled.
 */
import { AgentCapabilities } from '@/types/agent';
import { FileMessageContent, Message } from '@/types/chat';
import {
  CodeInterpreterFile,
  isCodeInterpreterSupported,
} from '@/types/codeInterpreter';
import { SearchMode } from '@/types/searchMode';

import { FileProcessingService } from '../FileProcessingService';
import { CodeInterpreterFileService } from '../codeInterpreter/CodeInterpreterFileService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * AgentEnricher adds AI Foundry agent capabilities.
 *
 * Runs when:
 * - agentMode is enabled
 * - Model has an agentId configured
 *
 * Modifies context:
 * - context.executionStrategy = 'agent'
 * - context.agentCapabilities (with Code Interpreter files if applicable)
 * - context.enrichedMessages (with file context if Code Interpreter)
 */
export class AgentEnricher extends BasePipelineStage {
  readonly name = 'AgentEnricher';
  private tracer = trace.getTracer('agent-enricher');

  constructor(
    private codeInterpreterFileService?: CodeInterpreterFileService,
    private fileProcessingService?: FileProcessingService,
  ) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    return !!context.agentMode && !!context.model.agentId;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    console.log(
      `[AgentEnricher] Using AI Foundry agent: ${context.model.agentId}`,
    );

    // Validate that model has agentId
    if (!context.model.agentId) {
      throw new Error(
        `Model ${context.modelId} does not have an agentId configured`,
      );
    }

    // Initialize capabilities
    const capabilities: AgentCapabilities = {};

    // Check if Code Interpreter is enabled and files are present
    const canUseCodeInterpreter =
      context.model.codeInterpreter &&
      context.hasFiles &&
      this.hasCompatibleFiles(context) &&
      this.codeInterpreterFileService &&
      this.fileProcessingService;

    if (canUseCodeInterpreter) {
      // Handle Code Interpreter capability
      return await this.handleCodeInterpreterCapability(context, capabilities);
    }

    // For agents without Code Interpreter:
    // If files or images are present, fall back to intelligent search
    // because standard agents don't support multimodal input
    if (context.hasFiles || context.hasImages) {
      console.warn(
        '[AgentEnricher] Agent mode with files/images not yet supported, falling back to intelligent search with standard execution',
      );
      // Switch to INTELLIGENT search mode to enable ToolRouterEnricher
      // This ensures users still get web search capability with files
      return {
        ...context,
        searchMode: SearchMode.INTELLIGENT,
        // Don't set executionStrategy='agent' - let StandardChatHandler run instead
      };
    }

    // Standard agent mode (Bing grounding enabled by default)
    capabilities.bingGrounding = { enabled: true };

    return {
      ...context,
      executionStrategy: 'agent',
      agentCapabilities: capabilities,
    };
  }

  /**
   * Checks if the context has at least one Code Interpreter compatible file.
   */
  private hasCompatibleFiles(context: ChatContext): boolean {
    const lastMessage = context.messages[context.messages.length - 1];
    if (!Array.isArray(lastMessage.content)) {
      return false;
    }

    return lastMessage.content.some(
      (section) =>
        section.type === 'file_url' &&
        section.originalFilename &&
        isCodeInterpreterSupported(section.originalFilename),
    );
  }

  /**
   * Handles Code Interpreter capability: uploads files and enriches context.
   */
  private async handleCodeInterpreterCapability(
    context: ChatContext,
    capabilities: AgentCapabilities,
  ): Promise<ChatContext> {
    return await this.tracer.startActiveSpan(
      'agent_enricher.code_interpreter',
      {
        attributes: {
          'user.id': context.user.id,
          'model.id': context.modelId,
        },
      },
      async (span) => {
        try {
          const uploadedFiles =
            await this.uploadFilesForCodeInterpreter(context);

          if (uploadedFiles.length === 0) {
            console.log(
              '[AgentEnricher] No files uploaded for Code Interpreter, using standard agent',
            );
            capabilities.bingGrounding = { enabled: true };
            return {
              ...context,
              executionStrategy: 'agent',
              agentCapabilities: capabilities,
            };
          }

          console.log(
            '[AgentEnricher] Code Interpreter files uploaded:',
            uploadedFiles.map((f) => ({ id: f.id, filename: f.filename })),
          );

          // Set Code Interpreter capability
          capabilities.codeInterpreter = {
            enabled: true,
            uploadedFiles,
          };

          // Inject file context into messages
          const enrichedMessages = this.injectFileContext(
            context,
            uploadedFiles,
          );

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('files.uploaded', uploadedFiles.length);
          span.setAttribute(
            'files.ids',
            uploadedFiles.map((f) => f.id).join(','),
          );

          return {
            ...context,
            executionStrategy: 'agent',
            agentCapabilities: capabilities,
            enrichedMessages,
          };
        } catch (error) {
          console.error('[AgentEnricher] Code Interpreter error:', error);
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

  /**
   * Downloads files from blob storage and uploads to AI Foundry.
   */
  private async uploadFilesForCodeInterpreter(
    context: ChatContext,
  ): Promise<CodeInterpreterFile[]> {
    const lastMessage = context.messages[context.messages.length - 1];

    if (!Array.isArray(lastMessage.content)) {
      return [];
    }

    // Extract file URLs and filenames from message content
    const files: Array<{ url: string; filename: string }> = [];

    for (const section of lastMessage.content) {
      if (section.type === 'file_url') {
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
      return [];
    }

    console.log(
      `[AgentEnricher] Uploading ${files.length} file(s) to AI Foundry`,
    );

    // Download files from blob storage and upload to AI Foundry
    const uploadedFiles = await Promise.all(
      files.map(async (file) => {
        // Download file from blob storage
        const [, filePath] = this.fileProcessingService!.getTempFilePath(
          file.url,
        );

        await this.fileProcessingService!.downloadFile(
          file.url,
          filePath,
          context.user,
        );

        const buffer = await this.fileProcessingService!.readFile(filePath);

        // Clean up temp file
        await this.fileProcessingService!.cleanupFile(filePath);

        // Upload to AI Foundry
        const uploadedFile = await this.codeInterpreterFileService!.uploadFile(
          buffer,
          file.filename,
        );

        return uploadedFile;
      }),
    );

    return uploadedFiles;
  }

  /**
   * Injects file context into the user message for Code Interpreter.
   *
   * Creates enriched messages where the last message includes file context
   * in a text-only format (files are attached via API).
   */
  private injectFileContext(
    context: ChatContext,
    uploadedFiles: CodeInterpreterFile[],
  ): Message[] {
    const lastMessage = context.messages[context.messages.length - 1];

    // Extract text content from the message
    let textContent = '';
    if (typeof lastMessage.content === 'string') {
      textContent = lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
      for (const section of lastMessage.content) {
        if (section.type === 'text') {
          textContent = section.text;
          break;
        }
      }
    }

    // Create file context
    const fileContext = uploadedFiles
      .map((f) => `[Uploaded file: ${f.filename} (ID: ${f.id})]`)
      .join('\n');

    const enrichedContent = `${fileContext}\n\n${textContent}`;

    // Create enriched messages array
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

    return enrichedMessages;
  }
}
