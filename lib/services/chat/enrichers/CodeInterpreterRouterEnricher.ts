/**
 * CodeInterpreterRouterEnricher
 *
 * Pipeline enricher that determines if Code Interpreter should be used
 * based on intelligent query analysis.
 *
 * Runs BEFORE AgentEnricher when codeInterpreterMode is INTELLIGENT.
 * Sets context.codeInterpreterRecommended based on AI analysis of the query.
 *
 * This enables intelligent routing where:
 * - "Summarize this PDF" -> Standard chat (no Code Interpreter)
 * - "Extract data to Excel" -> Code Interpreter
 * - "Generate Excel with dummy data" -> Code Interpreter (even without files)
 * - "Rewrite Python as R" -> Standard chat
 */
import { FileMessageContent } from '@/types/chat';
import {
  CodeInterpreterMode,
  isCodeInterpreterSupported,
} from '@/types/codeInterpreter';

import { CodeInterpreterRouterService } from '../codeInterpreter/CodeInterpreterRouterService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * CodeInterpreterRouterEnricher analyzes queries to determine Code Interpreter need.
 *
 * Runs when:
 * - codeInterpreterMode is INTELLIGENT
 * - Model supports Code Interpreter
 *
 * Modifies context:
 * - context.codeInterpreterRecommended = true/false
 */
export class CodeInterpreterRouterEnricher extends BasePipelineStage {
  readonly name = 'CodeInterpreterRouterEnricher';
  private tracer = trace.getTracer('code-interpreter-router-enricher');

  constructor(private routerService: CodeInterpreterRouterService) {
    super();
  }

  /**
   * Runs only when Code Interpreter mode is INTELLIGENT and model supports it.
   */
  shouldRun(context: ChatContext): boolean {
    // Only run for INTELLIGENT mode
    if (context.codeInterpreterMode !== CodeInterpreterMode.INTELLIGENT) {
      return false;
    }

    // Model must support Code Interpreter
    if (!context.model.codeInterpreter) {
      return false;
    }

    // Must be in agent mode with an agentId
    if (!context.agentMode || !context.model.agentId) {
      return false;
    }

    return true;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return await this.tracer.startActiveSpan(
      'code_interpreter_router_enricher.execute',
      {
        attributes: {
          'user.id': context.user.id,
          'model.id': context.modelId,
          has_files: context.hasFiles,
        },
      },
      async (span) => {
        try {
          // Extract current message text
          const lastMessage = context.messages[context.messages.length - 1];
          const currentMessage = this.extractTextFromContent(
            lastMessage.content,
          );

          // Extract file information from context
          const files = this.extractFileInfo(context);

          console.log('[CodeInterpreterRouterEnricher] Analyzing query:', {
            messagePreview: currentMessage.substring(0, 100),
            fileCount: files.length,
          });

          // Call router service to determine intent
          const result = await this.routerService.determineIntent({
            messages: context.messages,
            currentMessage,
            files,
            forceCodeInterpreter: false,
          });

          console.log('[CodeInterpreterRouterEnricher] Routing decision:', {
            needsCodeInterpreter: result.needsCodeInterpreter,
            reasoning: result.reasoning,
          });

          span.setAttribute('ci_recommended', result.needsCodeInterpreter);
          span.setAttribute('ci_reasoning', result.reasoning);
          span.setStatus({ code: SpanStatusCode.OK });

          return {
            ...context,
            codeInterpreterRecommended: result.needsCodeInterpreter,
          };
        } catch (error) {
          console.error('[CodeInterpreterRouterEnricher] Error:', error);
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });

          // Default to not recommending Code Interpreter on error
          // This preserves standard chat behavior as fallback
          return {
            ...context,
            codeInterpreterRecommended: false,
          };
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Extracts text content from message content structure.
   */
  private extractTextFromContent(
    content:
      | string
      | Array<{ type: string; text?: string }>
      | { type: string; text?: string },
  ): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter(
          (c): c is { type: string; text: string } =>
            c.type === 'text' && !!c.text,
        )
        .map((c) => c.text);
      return textParts.join('\n');
    }

    if (content && typeof content === 'object' && 'text' in content) {
      return content.text || '';
    }

    return '';
  }

  /**
   * Extracts file information from context for routing decision.
   */
  private extractFileInfo(
    context: ChatContext,
  ): Array<{ filename: string; type?: string }> {
    const files: Array<{ filename: string; type?: string }> = [];

    // Check last message for file content
    const lastMessage = context.messages[context.messages.length - 1];
    if (Array.isArray(lastMessage.content)) {
      for (const section of lastMessage.content) {
        if (section.type === 'file_url') {
          const fileContent = section as FileMessageContent;
          if (fileContent.originalFilename) {
            files.push({
              filename: fileContent.originalFilename,
              type: this.getFileType(fileContent.originalFilename),
            });
          }
        }
      }
    }

    // Also check processed content for file summaries
    if (context.processedContent?.fileSummaries) {
      for (const summary of context.processedContent.fileSummaries) {
        if (!files.some((f) => f.filename === summary.filename)) {
          files.push({
            filename: summary.filename,
            type: this.getFileType(summary.filename),
          });
        }
      }
    }

    return files;
  }

  /**
   * Gets a simplified file type based on extension.
   */
  private getFileType(filename: string): string {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));

    const typeMap: Record<string, string> = {
      // Data files
      '.csv': 'data',
      '.xlsx': 'spreadsheet',
      '.xls': 'spreadsheet',
      '.json': 'data',
      '.xml': 'data',
      '.parquet': 'data',
      '.tsv': 'data',

      // Documents
      '.pdf': 'document',
      '.docx': 'document',
      '.doc': 'document',
      '.txt': 'text',
      '.md': 'text',

      // Code
      '.py': 'code',
      '.ipynb': 'notebook',
      '.r': 'code',
      '.sql': 'code',

      // Images
      '.png': 'image',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.gif': 'image',
    };

    return typeMap[ext] || 'unknown';
  }
}
