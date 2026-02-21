import { appendMetadataToStream } from '@/lib/utils/app/metadata';

import { AgentCapabilities } from '@/types/agent';
import {
  CodeInterpreterMetadata,
  CodeInterpreterOutput,
} from '@/types/codeInterpreter';

import {
  BaseCapabilityHandler,
  BaseStreamState,
} from './BaseCapabilityHandler';

/**
 * State for tracking Code Interpreter stream processing.
 *
 * Tracks Python code execution, outputs, and metadata.
 */
interface CodeInterpreterState extends BaseStreamState {
  /** Buffer for partial text (unused but kept for consistency) */
  markerBuffer: string;

  /** Accumulated Python code from the execution */
  currentCode: string;

  /** All outputs generated during execution */
  outputs: CodeInterpreterOutput[];

  /** Metadata for the Code Interpreter execution */
  metadata: CodeInterpreterMetadata;
}

/**
 * Handles streaming for agents with Code Interpreter capability.
 *
 * Responsibilities:
 * - Process text deltas from thread.message.delta events
 * - Handle Code Interpreter step events (code input, outputs)
 * - Process execution outputs (logs, images, files)
 * - Extract file annotations from completed messages
 * - Append Code Interpreter metadata at stream end
 *
 * Code Interpreter enables Python execution in a sandboxed environment
 * for data analysis, chart generation, and iterative problem-solving.
 */
export class CodeInterpreterHandler extends BaseCapabilityHandler {
  readonly name = 'CodeInterpreterHandler';

  /**
   * Handles agents with Code Interpreter enabled.
   */
  canHandle(capabilities: AgentCapabilities | undefined): boolean {
    return capabilities?.codeInterpreter?.enabled === true;
  }

  protected initializeState(baseState: BaseStreamState): BaseStreamState {
    const uploadedFiles = baseState.context.uploadedFiles || [];

    const state: CodeInterpreterState = {
      ...baseState,
      markerBuffer: '',
      currentCode: '',
      outputs: [],
      metadata: {
        executionPhase: 'executing',
        outputs: [],
        uploadedFiles: uploadedFiles.map((f) => ({
          id: f.id,
          filename: f.filename,
          purpose: 'assistants' as const,
        })),
        code: undefined,
        error: undefined,
      },
    };
    return state;
  }

  protected async handleEvent(
    event: unknown,
    controller: ReadableStreamDefaultController,
    baseState: BaseStreamState,
  ): Promise<void> {
    const state = baseState as CodeInterpreterState;
    const eventMessage = event as { event: string; data: unknown };

    switch (eventMessage.event) {
      case 'thread.message.delta':
        this.handleMessageDelta(eventMessage.data, controller, state);
        break;

      case 'thread.run.step.delta':
        this.handleStepDelta(eventMessage.data, controller, state);
        break;

      case 'thread.message.completed':
        this.handleMessageCompleted(eventMessage.data, state);
        break;

      case 'thread.run.completed':
        this.handleRunCompleted(controller, state);
        break;

      case 'error':
        this.handleErrorEvent(eventMessage.data, controller, state);
        break;

      case 'done':
        controller.close();
        break;
    }
  }

  protected override handleError(
    error: unknown,
    controller: ReadableStreamDefaultController,
    baseState: BaseStreamState,
  ): void {
    const state = baseState as CodeInterpreterState;
    state.metadata.executionPhase = 'error';
    state.metadata.error =
      error instanceof Error ? error.message : String(error);
    super.handleError(error, controller, state);
  }

  /**
   * Processes text delta events (assistant's text responses).
   */
  private handleMessageDelta(
    data: unknown,
    controller: ReadableStreamDefaultController,
    state: CodeInterpreterState,
  ): void {
    const messageData = data as {
      delta?: {
        content?: Array<{
          type: string;
          text?: { value: string };
        }>;
      };
    };

    if (!messageData?.delta?.content) {
      return;
    }

    for (const contentPart of messageData.delta.content) {
      if (contentPart.type === 'text' && contentPart.text?.value) {
        this.enqueueText(controller, state, contentPart.text.value);
      }
    }
  }

  /**
   * Processes Code Interpreter step events (code execution).
   *
   * Handles:
   * - Code input (Python code being executed)
   * - Execution outputs (logs, images)
   */
  private handleStepDelta(
    data: unknown,
    controller: ReadableStreamDefaultController,
    state: CodeInterpreterState,
  ): void {
    const stepData = data as {
      delta?: {
        step_details?: {
          tool_calls?: Array<{
            type: string;
            code_interpreter?: {
              input?: string;
              outputs?: Array<{
                type: string;
                logs?: string;
                image?: {
                  file_id: string;
                };
              }>;
            };
          }>;
        };
      };
    };

    const toolCalls = stepData?.delta?.step_details?.tool_calls;
    if (!toolCalls) {
      return;
    }

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'code_interpreter') {
        continue;
      }

      const ci = toolCall.code_interpreter;
      if (!ci) {
        continue;
      }

      // Stream Python code input
      if (ci.input) {
        state.currentCode += ci.input;

        // Send code block indicator for UI rendering
        this.enqueueText(controller, state, `\n\`\`\`python\n${ci.input}`);
      }

      // Handle execution outputs
      if (ci.outputs) {
        for (const output of ci.outputs) {
          if (output.type === 'logs' && output.logs) {
            // Execution logs (print statements, etc.)
            state.outputs.push({
              type: 'logs',
              content: output.logs,
            });

            // Close code block if open and show logs
            this.enqueueText(
              controller,
              state,
              `\n\`\`\`\n\n**Output:**\n\`\`\`\n${output.logs}\n\`\`\`\n`,
            );
          } else if (output.type === 'image' && output.image?.file_id) {
            // Generated image (chart, plot, etc.)
            state.outputs.push({
              type: 'image',
              fileId: output.image.file_id,
              mimeType: 'image/png',
            });

            // Add placeholder for image - client will render
            this.enqueueText(
              controller,
              state,
              `\n\n![Generated Image](code_interpreter:${output.image.file_id})\n`,
            );
          }
        }
      }
    }
  }

  /**
   * Extracts file annotations from completed messages.
   */
  private handleMessageCompleted(
    data: unknown,
    state: CodeInterpreterState,
  ): void {
    const messageData = data as {
      content?: Array<{
        text?: {
          annotations?: Array<{
            type: string;
            text?: string;
            file_path?: {
              file_id: string;
            };
          }>;
        };
      }>;
    };

    const annotations = messageData?.content?.[0]?.text?.annotations;
    if (annotations) {
      for (const annotation of annotations) {
        if (annotation.type === 'file_path' && annotation.file_path?.file_id) {
          state.outputs.push({
            type: 'file',
            fileId: annotation.file_path.file_id,
            filename: annotation.text || 'generated_file',
          });
        }
      }
    }

    state.metadata.executionPhase = 'completed';
    state.metadata.code = state.currentCode || undefined;
    state.metadata.outputs = state.outputs;
  }

  /**
   * Finalizes the stream with Code Interpreter metadata.
   */
  private handleRunCompleted(
    controller: ReadableStreamDefaultController,
    state: CodeInterpreterState,
  ): void {
    // Flush any remaining buffer
    if (state.markerBuffer) {
      this.enqueueText(controller, state, state.markerBuffer);
    }

    // Update metadata
    state.metadata.executionPhase = 'completed';
    state.metadata.durationMs = Date.now() - state.context.startTime;

    // Append metadata
    appendMetadataToStream(controller, {
      threadId: state.context.isNewThread ? state.context.thread.id : undefined,
      codeInterpreter: state.metadata,
    });
  }

  /**
   * Handles error events from the stream.
   */
  private handleErrorEvent(
    data: unknown,
    controller: ReadableStreamDefaultController,
    state: CodeInterpreterState,
  ): void {
    state.metadata.executionPhase = 'error';
    state.metadata.error = JSON.stringify(data);

    controller.error(
      new Error(`Code Interpreter error: ${JSON.stringify(data)}`),
    );
  }
}
