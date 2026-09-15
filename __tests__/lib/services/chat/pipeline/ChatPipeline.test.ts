import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';
import {
  ChatPipeline,
  STAGE_TIMEOUTS,
  resolveStageTimeouts,
} from '@/lib/services/chat/pipeline/ChatPipeline';
import { PipelineStage } from '@/lib/services/chat/pipeline/PipelineStage';

import { ErrorCode, PipelineError } from '@/types/errors';

import { createTestChatContext, createTestMessage } from '../testUtils';

import { describe, expect, it, vi } from 'vitest';

describe('ChatPipeline', () => {
  describe('Per-stage timeouts', () => {
    it('should complete successfully when all stages finish within timeout', async () => {
      // Create a fast stage that completes in 10ms
      const fastStage: PipelineStage = {
        name: 'FastStage',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { ...context, processedContent: { metadata: { fast: true } } };
        },
      };

      const pipeline = new ChatPipeline([fastStage], { FastStage: 1000 });
      const context = createTestChatContext();

      const result = await pipeline.execute(context);

      expect(result.processedContent?.metadata?.fast).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should skip stage and continue pipeline when stage times out', async () => {
      // Create a slow stage that takes 200ms
      const slowStage: PipelineStage = {
        name: 'SlowStage',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { ...context, processedContent: { metadata: { slow: true } } };
        },
      };

      // Create a fast stage that runs after
      const fastStage: PipelineStage = {
        name: 'FastStage',
        shouldRun: () => true,
        execute: async (context) => {
          return {
            ...context,
            processedContent: {
              ...context.processedContent,
              metadata: { ...context.processedContent?.metadata, fast: true },
            },
          };
        },
      };

      const pipeline = new ChatPipeline([slowStage, fastStage], {
        SlowStage: 50,
      });
      const context = createTestChatContext();

      const result = await pipeline.execute(context);

      // SlowStage should have timed out (not set slow: true)
      expect(result.processedContent?.metadata?.slow).toBeUndefined();

      // FastStage should have run successfully
      expect(result.processedContent?.metadata?.fast).toBe(true);

      // Should have exactly one timeout warning
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]).toBeInstanceOf(PipelineError);
      expect((result.errors![0] as PipelineError).code).toBe(
        ErrorCode.PIPELINE_TIMEOUT,
      );
      expect((result.errors![0] as PipelineError).message).toContain(
        'SlowStage',
      );
    });

    it('calls the stage onTimeout hook on the pre-stage context when it times out', async () => {
      const slowStage: PipelineStage = {
        name: 'SlowStage',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { ...context, processedContent: { metadata: { slow: true } } };
        },
        onTimeout: (context) => ({
          ...context,
          processedContent: { metadata: { degraded: true } },
        }),
      };

      const pipeline = new ChatPipeline([slowStage], { SlowStage: 50 });
      const result = await pipeline.execute(createTestChatContext());

      expect(result.processedContent?.metadata?.slow).toBeUndefined();
      expect(result.processedContent?.metadata?.degraded).toBe(true);
      expect(result.errors).toHaveLength(1);
    });

    it('a throwing onTimeout hook does not break the pipeline', async () => {
      const slowStage: PipelineStage = {
        name: 'SlowStage',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return context;
        },
        onTimeout: () => {
          throw new Error('hook boom');
        },
      };
      const fastStage: PipelineStage = {
        name: 'FastStage',
        shouldRun: () => true,
        execute: async (context) => ({
          ...context,
          processedContent: { metadata: { fast: true } },
        }),
      };

      const pipeline = new ChatPipeline([slowStage, fastStage], {
        SlowStage: 50,
      });
      const result = await pipeline.execute(createTestChatContext());

      expect(result.processedContent?.metadata?.fast).toBe(true);
    });

    it('should use default timeout for stages without explicit timeout', async () => {
      const customStage: PipelineStage = {
        name: 'CustomStage',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            ...context,
            processedContent: { metadata: { custom: true } },
          };
        },
      };

      // CustomStage not in timeout config, should use default (30s)
      const pipeline = new ChatPipeline([customStage]);
      const context = createTestChatContext();

      const result = await pipeline.execute(context);

      expect(result.processedContent?.metadata?.custom).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle multiple stages with different timeouts', async () => {
      const stage1: PipelineStage = {
        name: 'Stage1',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            ...context,
            processedContent: { metadata: { stage1: true } },
          };
        },
      };

      const stage2: PipelineStage = {
        name: 'Stage2',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            ...context,
            processedContent: {
              ...context.processedContent,
              metadata: { ...context.processedContent?.metadata, stage2: true },
            },
          };
        },
      };

      const stage3: PipelineStage = {
        name: 'Stage3',
        shouldRun: () => true,
        execute: async (context) => {
          return {
            ...context,
            processedContent: {
              ...context.processedContent,
              metadata: { ...context.processedContent?.metadata, stage3: true },
            },
          };
        },
      };

      const pipeline = new ChatPipeline([stage1, stage2, stage3], {
        Stage1: 1000,
        Stage2: 50, // This will timeout
        Stage3: 1000,
      });
      const context = createTestChatContext();

      const result = await pipeline.execute(context);

      expect(result.processedContent?.metadata?.stage1).toBe(true);
      expect(result.processedContent?.metadata?.stage2).toBeUndefined(); // Timed out
      expect(result.processedContent?.metadata?.stage3).toBe(true);

      // Should have one timeout error for Stage2
      expect(result.errors).toHaveLength(1);
      expect((result.errors![0] as PipelineError).metadata?.stageName).toBe(
        'Stage2',
      );
    });

    it('should include timeout metadata in error', async () => {
      const slowStage: PipelineStage = {
        name: 'SlowProcessor',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return context;
        },
      };

      const pipeline = new ChatPipeline([slowStage], { SlowProcessor: 50 });
      const context = createTestChatContext();

      const result = await pipeline.execute(context);

      expect(result.errors).toHaveLength(1);
      const error = result.errors![0] as PipelineError;

      expect(error.code).toBe(ErrorCode.PIPELINE_TIMEOUT);
      expect(error.metadata?.stageName).toBe('SlowProcessor');
      expect(error.metadata?.timeoutMs).toBe(50);
      expect(error.message).toContain('SlowProcessor');
      expect(error.message).toContain('50ms');
    });

    it('should not timeout stages that are skipped', async () => {
      const skippedStage: PipelineStage = {
        name: 'SkippedStage',
        shouldRun: () => false,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return context;
        },
      };

      const pipeline = new ChatPipeline([skippedStage], { SkippedStage: 50 });
      const context = createTestChatContext();

      const result = await pipeline.execute(context);

      // No timeout because stage was skipped
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('FileProcessor error sanitization', () => {
    const fileMessage = createTestMessage({
      content: [
        { type: 'text', text: 'Transcribe this audio' },
        {
          type: 'file_url',
          file_url: { url: 'https://example.com/audio.mp3' },
        },
      ] as never,
    });

    it('should sanitize file_url content when FileProcessor adds errors', async () => {
      const fileProcessorStage: PipelineStage = {
        name: 'FileProcessor',
        shouldRun: () => true,
        execute: async (context) => {
          const errors = context.errors || [];
          errors.push(new Error('Whisper API failed'));
          return { ...context, errors };
        },
      };

      const context = createTestChatContext({ messages: [fileMessage] });
      const pipeline = new ChatPipeline([fileProcessorStage], {
        FileProcessor: 5000,
      });

      const result = await pipeline.execute(context);

      // file_url should be removed from messages
      const content = result.messages[0].content;
      expect(
        typeof content === 'string' ||
          !Array.isArray(content) ||
          content.every((c: { type: string }) => c.type !== 'file_url'),
      ).toBe(true);

      // fileProcessingFailed flag should be set
      expect(result.processedContent?.metadata?.fileProcessingFailed).toBe(
        true,
      );

      // Notice text should be present
      const textContent = typeof content === 'string' ? content : '';
      expect(textContent).toContain('could not be processed');
    });

    it('should sanitize file_url content when FileProcessor times out', async () => {
      const slowFileProcessor: PipelineStage = {
        name: 'FileProcessor',
        shouldRun: () => true,
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return context;
        },
      };

      const context = createTestChatContext({ messages: [fileMessage] });
      const pipeline = new ChatPipeline([slowFileProcessor], {
        FileProcessor: 50,
      });

      const result = await pipeline.execute(context);

      // fileProcessingFailed flag should be set
      expect(result.processedContent?.metadata?.fileProcessingFailed).toBe(
        true,
      );

      // Should have a timeout error
      expect(
        result.errors!.some(
          (e) =>
            e instanceof PipelineError && e.code === ErrorCode.PIPELINE_TIMEOUT,
        ),
      ).toBe(true);
    });

    it('should NOT sanitize when a non-FileProcessor stage adds errors', async () => {
      const otherStage: PipelineStage = {
        name: 'OtherStage',
        shouldRun: () => true,
        execute: async (context) => {
          const errors = context.errors || [];
          errors.push(new Error('Some other error'));
          return { ...context, errors };
        },
      };

      const context = createTestChatContext({ messages: [fileMessage] });
      const pipeline = new ChatPipeline([otherStage], { OtherStage: 5000 });

      const result = await pipeline.execute(context);

      // file_url should still be present (no sanitization)
      const content = result.messages[0].content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(
          content.some((c: { type: string }) => c.type === 'file_url'),
        ).toBe(true);
      }

      // fileProcessingFailed should NOT be set
      expect(
        result.processedContent?.metadata?.fileProcessingFailed,
      ).toBeUndefined();
    });

    it('should NOT sanitize when FileProcessor succeeds without errors', async () => {
      const successfulFileProcessor: PipelineStage = {
        name: 'FileProcessor',
        shouldRun: () => true,
        execute: async (context) => {
          return {
            ...context,
            processedContent: { metadata: { processed: true } },
          };
        },
      };

      const context = createTestChatContext({ messages: [fileMessage] });
      const pipeline = new ChatPipeline([successfulFileProcessor], {
        FileProcessor: 5000,
      });

      const result = await pipeline.execute(context);

      // fileProcessingFailed should NOT be set
      expect(
        result.processedContent?.metadata?.fileProcessingFailed,
      ).toBeUndefined();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Integration with existing error handling', () => {
    it('should stop pipeline on critical errors even with timeouts configured', async () => {
      const criticalStage: PipelineStage = {
        name: 'CriticalStage',
        shouldRun: () => true,
        execute: async (context) => {
          const errors = context.errors || [];
          errors.push(
            PipelineError.critical(
              ErrorCode.VALIDATION_FAILED,
              'Critical error',
            ),
          );
          return { ...context, errors };
        },
      };

      const nextStage: PipelineStage = {
        name: 'NextStage',
        shouldRun: () => true,
        execute: async (context) => {
          return { ...context, processedContent: { metadata: { next: true } } };
        },
      };

      const pipeline = new ChatPipeline([criticalStage, nextStage]);
      const context = createTestChatContext();

      const result = await pipeline.execute(context);

      // NextStage should not have run due to critical error
      expect(result.processedContent?.metadata?.next).toBeUndefined();
      expect(result.errors).toHaveLength(1);
    });
  });
});

describe('ChatPipeline - model timeout (issue #130)', () => {
  it('resolveStageTimeouts overrides ONLY the model handler stages', () => {
    const resolved = resolveStageTimeouts(240_000);
    expect(resolved.StandardChatHandler).toBe(240_000);
    expect(resolved.AgentChatHandler).toBe(240_000);
    expect(resolved.FileProcessor).toBe(STAGE_TIMEOUTS.FileProcessor);
    expect(resolved.ToolRouterEnricher).toBe(STAGE_TIMEOUTS.ToolRouterEnricher);
    // Absent → the compiled defaults, untouched.
    expect(resolveStageTimeouts(undefined)).toBe(STAGE_TIMEOUTS);
    expect(STAGE_TIMEOUTS.StandardChatHandler).toBe(90_000);
  });

  it('never shortens the agent handler below its default (the client default is 90 s)', () => {
    const resolved = resolveStageTimeouts(90_000);
    expect(resolved.StandardChatHandler).toBe(90_000);
    expect(resolved.AgentChatHandler).toBe(STAGE_TIMEOUTS.AgentChatHandler);
    expect(resolveStageTimeouts(30_000).AgentChatHandler).toBe(
      STAGE_TIMEOUTS.AgentChatHandler,
    );
    expect(resolveStageTimeouts(30_000).StandardChatHandler).toBe(30_000);
  });

  it('hands every stage a signal and aborts it when that stage times out', async () => {
    let slowSignal: AbortSignal | undefined;
    let fastSignal: AbortSignal | undefined;
    const slowStage: PipelineStage = {
      name: 'StandardChatHandler',
      shouldRun: () => true,
      execute: async (context) => {
        slowSignal = context.stageSignal;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return context;
      },
    };
    const fastStage: PipelineStage = {
      name: 'FastStage',
      shouldRun: () => true,
      execute: async (context) => {
        fastSignal = context.stageSignal;
        return context;
      },
    };

    const pipeline = new ChatPipeline([slowStage, fastStage], {
      StandardChatHandler: 50,
      FastStage: 1000,
    });
    const result = await pipeline.execute(createTestChatContext());

    expect(slowSignal).toBeInstanceOf(AbortSignal);
    expect(slowSignal!.aborted).toBe(true);
    // The abort reason carries the same PIPELINE_TIMEOUT error the pipeline
    // records, so handlers can tell a timeout from a client disconnect.
    expect(slowSignal!.reason).toBeInstanceOf(PipelineError);
    expect((slowSignal!.reason as PipelineError).code).toBe(
      ErrorCode.PIPELINE_TIMEOUT,
    );
    expect((slowSignal!.reason as PipelineError).metadata?.stageName).toBe(
      'StandardChatHandler',
    );
    expect((slowSignal!.reason as PipelineError).metadata?.timeoutMs).toBe(50);

    // The stage that finished in time keeps an un-aborted signal.
    expect(fastSignal).toBeInstanceOf(AbortSignal);
    expect(fastSignal!.aborted).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('never aborts a stage that returned in time, even after its timeout would have elapsed', async () => {
    let signal: AbortSignal | undefined;
    const stage: PipelineStage = {
      name: 'StandardChatHandler',
      shouldRun: () => true,
      execute: async (context) => {
        signal = context.stageSignal;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return context;
      },
    };
    const pipeline = new ChatPipeline([stage], { StandardChatHandler: 40 });
    await pipeline.execute(createTestChatContext());
    // Wait past the configured timeout: the timer was cleared, so nothing
    // fires late against the (already consumed) stage.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(signal!.aborted).toBe(false);
  });

  it('does not time out a handler whose Response BODY is slow — only the start counts', async () => {
    // The handler returns immediately with a stream that takes far longer
    // than the stage timeout to produce bytes. The stage must resolve on
    // the Response, not on the body.
    const slowBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    });
    const handler: PipelineStage = {
      name: 'StandardChatHandler',
      shouldRun: () => true,
      execute: async (context) => ({
        ...context,
        response: new Response(slowBody, {
          headers: { 'Content-Type': 'text/plain' },
        }),
      }),
    };
    const pipeline = new ChatPipeline([handler], { StandardChatHandler: 30 });
    const result = await pipeline.execute(createTestChatContext());

    expect(result.errors).toHaveLength(0);
    expect(result.response).toBeDefined();
    // And the body still streams to completion afterwards, untimed.
    expect(await result.response!.text()).toBe('hello');
  });

  it('a request-level signal aborts the running stage and skips the rest', async () => {
    const requestAbort = new AbortController();
    let slowSignal: AbortSignal | undefined;
    let laterRan = false;
    const slowStage: PipelineStage = {
      name: 'FileProcessor',
      shouldRun: () => true,
      execute: async (context) => {
        slowSignal = context.stageSignal;
        // The route's guard fires while this stage is still working.
        setTimeout(() => requestAbort.abort(new Error('REQUEST_TIMEOUT')), 20);
        await new Promise((resolve) => setTimeout(resolve, 60));
        return context;
      },
    };
    const laterStage: PipelineStage = {
      name: 'StandardChatHandler',
      shouldRun: () => true,
      execute: async (context) => {
        laterRan = true;
        return context;
      },
    };

    const pipeline = new ChatPipeline([slowStage, laterStage], {
      FileProcessor: 1000,
      StandardChatHandler: 1000,
    });
    const result = await pipeline.execute(createTestChatContext(), {
      signal: requestAbort.signal,
    });

    expect(slowSignal!.aborted).toBe(true);
    expect((slowSignal!.reason as Error).message).toBe('REQUEST_TIMEOUT');
    // The model stage never started on a request already reported failed.
    expect(laterRan).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it('a request signal aborted before a stage starts stops the pipeline immediately', async () => {
    const requestAbort = new AbortController();
    requestAbort.abort(new Error('client gone'));
    let ran = false;
    const stage: PipelineStage = {
      name: 'StandardChatHandler',
      shouldRun: () => true,
      execute: async (context) => {
        ran = true;
        return context;
      },
    };
    await new ChatPipeline([stage]).execute(createTestChatContext(), {
      signal: requestAbort.signal,
    });
    expect(ran).toBe(false);
  });
});
