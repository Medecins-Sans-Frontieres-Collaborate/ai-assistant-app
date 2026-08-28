import { Session } from 'next-auth';

import {
  recordTokenUsage,
  recordToolCall,
} from '@/lib/services/observability/tokenUsageRecorder';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logTokenUsage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logToolCall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const recordMetric = vi.hoisted(() => vi.fn());
const debit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/lib/services/observability/AzureMonitorLoggingService', () => ({
  getAzureMonitorLogger: () => ({ logTokenUsage, logToolCall }),
}));
vi.mock('@/lib/services/observability/MetricsService', () => ({
  MetricsService: { recordTokenUsage: recordMetric },
}));
vi.mock('@/lib/services/limits/tokenDebit', () => ({
  debitTokenUsage: debit,
}));

const user = { id: 'u1', mail: 'u1@example.com' } as Session['user'];
const model = OpenAIModels[OpenAIModelID.GPT_5_2];
const usage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  modelId: 'gpt-5.2',
  region: 'EU' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordTokenUsage', () => {
  it('logs the TokenUsage event with telemetry, records the metric and debits the quota', () => {
    const telemetry = {
      botId: 'msf_communications',
      agentKind: 'rag' as const,
      requestId: 'req-1',
    };
    recordTokenUsage(usage, model, user, true, telemetry);

    expect(logTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        user,
        model: 'gpt-5.2',
        region: 'EU',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        streamed: true,
        telemetry,
        sizeClass: expect.any(String),
        assumptionsVersion: expect.any(String),
      }),
    );
    expect(recordMetric).toHaveBeenCalledWith(
      { prompt: 10, completion: 5, total: 15 },
      expect.objectContaining({
        operation: 'chat',
        botId: 'msf_communications',
      }),
    );
    expect(debit).toHaveBeenCalledWith(user, 15);
  });

  it("uses the 'agent' operation for Foundry agent usage", () => {
    recordTokenUsage(usage, model, user, true, { agentKind: 'foundry' });
    expect(recordMetric).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'agent' }),
    );
  });

  it('skips the quota debit when debit=false', () => {
    recordTokenUsage(usage, model, user, false, undefined, { debit: false });
    expect(logTokenUsage).toHaveBeenCalledTimes(1);
    expect(debit).not.toHaveBeenCalled();
  });

  it('never throws when a sink throws', () => {
    recordMetric.mockImplementationOnce(() => {
      throw new Error('otel down');
    });
    expect(() => recordTokenUsage(usage, model, user, true)).not.toThrow();
  });
});

describe('recordToolCall', () => {
  it('maps the tool-loop info onto the ToolCall event', () => {
    recordToolCall(
      {
        toolName: 'mail_search',
        serverId: 'builtin-m365',
        serverLabel: 'Microsoft 365',
        durationMs: 12,
        success: false,
        errorMessage: 'throttled',
      },
      'gpt-5.2',
      user,
      { requestId: 'req-1', loopRound: 1 },
    );
    expect(logToolCall).toHaveBeenCalledWith({
      user,
      toolName: 'mail_search',
      toolServer: 'builtin-m365',
      success: false,
      duration: 12,
      errorMessage: 'throttled',
      model: 'gpt-5.2',
      telemetry: { requestId: 'req-1', loopRound: 1 },
    });
  });
});
