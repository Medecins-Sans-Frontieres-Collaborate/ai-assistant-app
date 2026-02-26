import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { AgentEnricher } from '@/lib/services/chat/enrichers/AgentEnricher';
import { RAGEnricher } from '@/lib/services/chat/enrichers/RAGEnricher';
import { ToolRouterEnricher } from '@/lib/services/chat/enrichers/ToolRouterEnricher';
import { AgentChatHandler } from '@/lib/services/chat/handlers/AgentChatHandler';
import { StandardChatHandler } from '@/lib/services/chat/handlers/StandardChatHandler';
import { ChatPipeline, buildChatContext } from '@/lib/services/chat/pipeline';
import {
  ActiveFileInjector,
  ActiveFileProcessor,
} from '@/lib/services/chat/processors';
import { FileProcessor } from '@/lib/services/chat/processors/FileProcessor';
import { ImageProcessor } from '@/lib/services/chat/processors/ImageProcessor';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { ErrorCode, PipelineError } from '@/types/errors';

import { env } from '@/config/environment';

/**
 * POST /api/chat
 *
 * UNIFIED CHAT ENDPOINT
 *
 * Handles ALL types of chat requests through a composable pipeline:
 * - Text-only conversations
 * - Image conversations (vision models)
 * - File analysis (documents)
 * - Audio/video transcription
 * - Mixed content (files + images)
 * - RAG with knowledge bases
 * - Intelligent search (tool routing)
 * - AI Foundry agents
 *
 * ANY COMBINATION of the above is supported through composition.
 *
 * Request body (ChatBody):
 * - model: OpenAIModel - The model to use
 * - messages: Message[] - The conversation messages
 * - prompt?: string - System prompt (optional)
 * - temperature?: number - Temperature setting (optional)
 * - stream?: boolean - Whether to stream response (default: true)
 * - botId?: string - Bot/knowledge base ID for RAG (optional)
 * - searchMode?: SearchMode - Search mode for tool routing (optional)
 * - reasoningEffort?: string - For reasoning models (optional)
 * - verbosity?: string - Response verbosity (optional)
 * - threadId?: string - Thread ID for agents (optional)
 * - forcedAgentType?: string - Force specific agent type (optional)
 *
 * Pipeline Stages:
 * 1. Content Processing:
 *    - FileProcessor: Downloads, extracts, summarizes files
 *    - ImageProcessor: Validates images
 * 2. Feature Enrichment:
 *    - RAGEnricher: Adds knowledge base integration
 *    - ToolRouterEnricher: Adds intelligent search
 *    - AgentEnricher: Switches to agent execution
 * 3. Execution:
 *    - StandardChatHandler: Executes chat with OpenAI
 *
 * Returns:
 * - Streaming: text/plain with SSE-style streaming
 * - Non-streaming: application/json with { text: string }
 */
export async function POST(req: NextRequest): Promise<Response> {
  // Request timeout increased to handle large file downloads + processing
  // Large video files (351MB+) can take 60-90s to download, plus extraction and batch job submission
  const timeoutMs = 300000; // 5 minutes for file processing scenarios

  try {
    // Create timeout promise
    const timeoutPromise = new Promise<Response>((_, reject) => {
      setTimeout(() => {
        reject(
          PipelineError.critical(
            ErrorCode.REQUEST_TIMEOUT,
            `Request timed out after ${timeoutMs / 1000} seconds`,
            { timeoutMs },
          ),
        );
      }, timeoutMs);
    });

    // Create execution promise
    const executionPromise = (async () => {
      // 1. Build context through middleware
      console.log('[Unified Chat] Building context...');
      const context = await buildChatContext(req);

      console.log('[Unified Chat] Context built:', {
        model: context.modelId,
        contentTypes: Array.from(context.contentTypes),
        hasFiles: context.hasFiles,
        hasImages: context.hasImages,
        hasRAG: !!context.botId,
        searchMode: context.searchMode, // Show actual value instead of boolean
        hasAgent: context.agentMode,
      });

      // 2. Get services from container (singleton, reused across requests)
      console.log('[Unified Chat] Getting services from container...');
      const container = ServiceContainer.getInstance();

      const fileProcessingService = container.getFileProcessingService();
      const toolRouterService = container.getToolRouterService();
      const agentChatService = container.getAgentChatService();
      const aiFoundryAgentHandler = container.getAIFoundryAgentHandler();
      const standardChatService = container.getStandardChatService();

      // 3. Build pipeline
      console.log('[Unified Chat] Building pipeline...');
      const inputValidator = new InputValidator();
      // Create blob storage client for batch transcription support
      const blobStorageClient = createBlobStorageClient(context.session);
      // Get Foundry OpenAI client for RAG service (uses gpt-5-mini for query reformulation)
      const foundryOpenAIClient = container.getOpenAIClient();
      const pipeline = new ChatPipeline([
        // Content processors
        new FileProcessor(
          fileProcessingService,
          inputValidator,
          blobStorageClient,
        ),
        new ImageProcessor(),
        // Active files (process cache + inject context)
        new ActiveFileProcessor(),
        new ActiveFileInjector(),

        // Feature enrichers
        new RAGEnricher(
          env.SEARCH_ENDPOINT!,
          env.SEARCH_INDEX!,
          foundryOpenAIClient,
        ),
        new ToolRouterEnricher(toolRouterService, agentChatService),
        new AgentEnricher(),

        // Execution handlers (AgentChatHandler runs first, StandardChatHandler as fallback)
        new AgentChatHandler(aiFoundryAgentHandler),
        new StandardChatHandler(standardChatService),
      ]);

      console.log('[Unified Chat] Pipeline stages:', pipeline.getStageNames());

      // 4. Execute pipeline
      console.log('[Unified Chat] Executing pipeline...');
      const result = await pipeline.execute(context);

      // 5. Check for errors
      if (result.errors && result.errors.length > 0) {
        console.error(
          '[Unified Chat] Pipeline completed with errors:',
          result.errors.map((e) => sanitizeForLog(e.message)),
        );

        // If no response was generated, return error
        if (!result.response) {
          const firstError = result.errors[0];
          const errorCode =
            firstError instanceof PipelineError
              ? firstError.code
              : ErrorCode.INTERNAL_ERROR;

          // Map error codes to appropriate HTTP status codes
          const getStatusCodeForPipelineError = (code: ErrorCode): number => {
            switch (code) {
              case ErrorCode.AUTH_FAILED:
              case ErrorCode.RATE_LIMIT_EXCEEDED:
                return 401;
              case ErrorCode.VALIDATION_FAILED:
                return 400;
              case ErrorCode.REQUEST_TIMEOUT:
              case ErrorCode.PIPELINE_TIMEOUT:
                return 408;
              default:
                return 500;
            }
          };

          return new Response(
            JSON.stringify({
              error: 'Internal Server Error',
              code: errorCode,
              message: firstError.message,
              details: result.errors.map((e) =>
                e instanceof PipelineError
                  ? e.toJSON()
                  : { message: e.message },
              ),
            }),
            {
              status: getStatusCodeForPipelineError(errorCode),
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
      }

      // 6. Return response
      if (!result.response) {
        throw PipelineError.critical(
          ErrorCode.INTERNAL_ERROR,
          'Pipeline did not generate a response',
        );
      }

      console.log('[Unified Chat] Request completed successfully');
      console.log('[Unified Chat] Total time:', {
        duration: result.metrics?.endTime
          ? `${result.metrics.endTime - result.metrics.startTime}ms`
          : 'unknown',
      });

      return result.response;
    })(); // End of executionPromise

    // Race between timeout and execution
    return await Promise.race([executionPromise, timeoutPromise]);
  } catch (error) {
    console.error('[Unified Chat] Error:', sanitizeForLog(error));

    // Handle PipelineError with structured response
    if (error instanceof PipelineError) {
      // Map error codes to appropriate HTTP status codes
      const getStatusCode = (code: ErrorCode): number => {
        switch (code) {
          case ErrorCode.AUTH_FAILED:
          case ErrorCode.RATE_LIMIT_EXCEEDED:
            return 401;
          case ErrorCode.VALIDATION_FAILED:
            return 400;
          case ErrorCode.REQUEST_TIMEOUT:
          case ErrorCode.PIPELINE_TIMEOUT:
            return 408;
          default:
            return 500;
        }
      };

      return new Response(
        JSON.stringify({
          error: error.severity === 'CRITICAL' ? 'Critical Error' : 'Error',
          code: error.code,
          message: error.message,
          ...(error.metadata && { metadata: error.metadata }),
        }),
        {
          status: getStatusCode(error.code),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Handle generic errors
    return new Response(
      JSON.stringify({
        error: 'Internal Server Error',
        code: ErrorCode.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
