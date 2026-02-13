/**
 * MetricsService for business metrics and custom telemetry
 *
 * Tracks:
 * - Token usage per user/department/company
 * - Request costs
 * - File processing metrics
 * - Agent execution metrics
 * - User engagement metrics
 *
 * Integrates with OpenTelemetry for Azure Monitor
 */
import { Session } from 'next-auth';

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('msf-ai-assistant-metrics');

// Counters
const tokenCounter = meter.createCounter('tokens.usage', {
  description: 'Total tokens consumed',
  unit: 'tokens',
});

const requestCounter = meter.createCounter('requests.count', {
  description: 'Total requests by type',
  unit: 'requests',
});

const fileProcessingCounter = meter.createCounter('files.processed', {
  description: 'Files processed by type',
  unit: 'files',
});

const errorCounter = meter.createCounter('errors.count', {
  description: 'Errors by type',
  unit: 'errors',
});

// Histograms for distributions
const requestDurationHistogram = meter.createHistogram('request.duration', {
  description: 'Request duration distribution',
  unit: 'ms',
});

const tokenCostHistogram = meter.createHistogram('tokens.cost', {
  description: 'Estimated cost per request',
  unit: 'usd',
});

export class MetricsService {
  /**
   * Record token usage with user context
   */
  static recordTokenUsage(
    tokens: {
      prompt?: number;
      completion?: number;
      total: number;
    },
    context: {
      user: Session['user'];
      model: string;
      operation: 'chat' | 'file_processing' | 'agent' | 'transcription';
      botId?: string;
    },
  ) {
    const attributes = {
      'user.id': context.user.id,
      'user.email': context.user.mail || 'unknown',
      'user.department': context.user.department || 'unknown',
      'user.company': context.user.companyName || 'unknown',
      'user.job_title': context.user.jobTitle || 'unknown',
      'model.id': context.model,
      'operation.type': context.operation,
      'bot.id': context.botId || 'none',
    };

    // Record total tokens
    tokenCounter.add(tokens.total, {
      ...attributes,
      'token.type': 'total',
    });

    // Record prompt tokens if available
    if (tokens.prompt) {
      tokenCounter.add(tokens.prompt, {
        ...attributes,
        'token.type': 'prompt',
      });
    }

    // Record completion tokens if available
    if (tokens.completion) {
      tokenCounter.add(tokens.completion, {
        ...attributes,
        'token.type': 'completion',
      });
    }

    // Estimate cost (simplified - adjust based on actual pricing)
    const estimatedCost = this.estimateCost(tokens.total, context.model);
    if (estimatedCost > 0) {
      tokenCostHistogram.record(estimatedCost, attributes);
    }

    console.log(
      `[Metrics] Token usage: ${tokens.total} tokens for ${context.user.mail} (${context.operation})`,
    );
  }

  /**
   * Record request completion
   */
  static recordRequest(
    operation:
      | 'chat'
      | 'file_upload'
      | 'transcription'
      | 'agent'
      | 'rag'
      | 'code_interpreter',
    duration: number,
    context: {
      user: Session['user'];
      success: boolean;
      model?: string;
      botId?: string;
    },
  ) {
    const attributes = {
      'user.id': context.user.id,
      'user.email': context.user.mail || 'unknown',
      'user.department': context.user.department || 'unknown',
      'user.company': context.user.companyName || 'unknown',
      'operation.type': operation,
      'operation.success': context.success,
      'model.id': context.model || 'none',
      'bot.id': context.botId || 'none',
    };

    requestCounter.add(1, attributes);
    requestDurationHistogram.record(duration, attributes);
  }

  /**
   * Record file processing
   */
  static recordFileProcessing(
    fileType: 'document' | 'audio' | 'video' | 'image',
    context: {
      user: Session['user'];
      success: boolean;
      fileSize: number;
      processingTime: number;
      filename?: string;
    },
  ) {
    const attributes = {
      'user.id': context.user.id,
      'user.email': context.user.mail || 'unknown',
      'user.department': context.user.department || 'unknown',
      'user.company': context.user.companyName || 'unknown',
      'file.type': fileType,
      'file.size': context.fileSize,
      'operation.success': context.success,
    };

    fileProcessingCounter.add(1, attributes);
    requestDurationHistogram.record(context.processingTime, {
      ...attributes,
      'operation.type': 'file_processing',
    });

    console.log(
      `[Metrics] File processed: ${fileType} (${context.fileSize} bytes) for ${context.user.mail}`,
    );
  }

  /**
   * Record error occurrence
   */
  static recordError(
    errorType: string,
    context: {
      user?: Session['user'];
      operation?: string;
      model?: string;
      message?: string;
    },
  ) {
    const attributes = {
      'user.id': context.user?.id || 'unknown',
      'user.email': context.user?.mail || 'unknown',
      'user.department': context.user?.department || 'unknown',
      'error.type': errorType,
      'operation.type': context.operation || 'unknown',
      'model.id': context.model || 'none',
    };

    errorCounter.add(1, attributes);

    console.error(
      `[Metrics] Error recorded: ${errorType} - ${context.message || 'No message'}`,
    );
  }

  /**
   * Estimate cost based on tokens and model
   * Prices as of 2024 (adjust as needed)
   */
  private static estimateCost(tokens: number, model: string): number {
    // Simplified cost estimation - update with actual pricing
    const costPerMillionTokens: Record<string, number> = {
      'gpt-4': 30.0, // $30 per 1M tokens (average of input/output)
      'gpt-4o': 5.0, // $5 per 1M tokens
      'gpt-4.1': 5.0,
      'gpt-4-turbo': 10.0,
      'gpt-35-turbo': 1.5,
      'gpt-5': 15.0, // Reasoning model
      o1: 40.0, // Premium reasoning
      o3: 50.0,
    };

    // Find matching model
    const modelKey = Object.keys(costPerMillionTokens).find((key) =>
      model.toLowerCase().includes(key.toLowerCase()),
    );

    if (!modelKey) {
      return 0; // Unknown model
    }

    const costPerToken = costPerMillionTokens[modelKey] / 1_000_000;
    return tokens * costPerToken;
  }
}
