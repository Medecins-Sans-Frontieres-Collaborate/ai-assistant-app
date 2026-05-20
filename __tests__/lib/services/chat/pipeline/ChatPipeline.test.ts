import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';
import { ChatPipeline } from '@/lib/services/chat/pipeline/ChatPipeline';
import { PipelineStage } from '@/lib/services/chat/pipeline/PipelineStage';

import { ErrorCode, PipelineError } from '@/types/errors';

import { createTestChatContext } from '../testUtils';

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
