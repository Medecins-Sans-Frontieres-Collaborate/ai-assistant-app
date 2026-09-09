/**
 * tokenUsageRecorder — the one per-request sink. Contract under test:
 *  - one TokenUsage event, one OTel metric call and one quota debit per call;
 *  - the OTel call carries `estimatedCostUsd` computed from the SERVED
 *    model's catalog pricing and the real token counts (design §4d): list
 *    rate, Global Standard, output ×1, no cached share — and the field is
 *    ABSENT (never 0) for agents, BYO sources, local runtimes and unpriced
 *    catalog entries;
 *  - the Azure Monitor row is NOT given a cost column (prod's DCR schema
 *    drift would silently drop it);
 *  - nothing here ever throws into the chat path.
 */
import { Session } from 'next-auth';

import {
  estimatedCostUsdFor,
  recordTokenUsage,
  recordToolCall,
} from '@/lib/services/observability/tokenUsageRecorder';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

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
/** gpt-5.2 list price: 10 × $1.75/1M + 5 × $14/1M. */
const GPT_5_2_COST_10_5 = (10 * 1.75 + 5 * 14) / 1e6;
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
      {
        prompt: 10,
        completion: 5,
        total: 15,
        estimatedCostUsd: expect.any(Number),
      },
      expect.objectContaining({
        operation: 'chat',
        botId: 'msf_communications',
      }),
    );
    expect(recordMetric.mock.calls[0][0].estimatedCostUsd).toBeCloseTo(
      GPT_5_2_COST_10_5,
      10,
    );
    expect(debit).toHaveBeenCalledWith(user, 15);
  });

  it('does NOT add a cost column to the Azure Monitor row (DCR schema is unchanged)', () => {
    recordTokenUsage(usage, model, user, true);
    const row = logTokenUsage.mock.calls[0][0];
    expect(Object.keys(row).some((k) => /cost/i.test(k))).toBe(false);
  });

  it('omits estimatedCostUsd (rather than sending 0) for an agent wrapper that inherited base-model pricing', () => {
    const agent: OpenAIModel = {
      ...model,
      id: 'org-msf-communications',
      modelType: 'agent',
      isOrganizationAgent: true,
    };
    recordTokenUsage(
      { ...usage, modelId: 'org-msf-communications' },
      agent,
      user,
      true,
      { agentKind: 'foundry' },
    );
    expect(recordMetric).toHaveBeenCalledWith(
      { prompt: 10, completion: 5, total: 15 },
      expect.objectContaining({ operation: 'agent' }),
    );
    expect(recordMetric.mock.calls[0][0]).not.toHaveProperty(
      'estimatedCostUsd',
    );
    // Tokens are still logged and debited — only the price is unknowable.
    expect(logTokenUsage).toHaveBeenCalledTimes(1);
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

  it('a malformed token count skips the cost but still logs, meters and debits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = { ...usage, promptTokens: -1, totalTokens: 4 };
    expect(() => recordTokenUsage(bad, model, user, true)).not.toThrow();
    expect(logTokenUsage).toHaveBeenCalledTimes(1);
    expect(recordMetric.mock.calls[0][0]).not.toHaveProperty(
      'estimatedCostUsd',
    );
    expect(debit).toHaveBeenCalledWith(user, 4);
    warn.mockRestore();
  });
});

describe('estimatedCostUsdFor', () => {
  const tokens = { promptTokens: 1000, completionTokens: 500 };

  it('prices from the served model at list rate, Global Standard, output ×1, no cache', () => {
    // gpt-5.2: 1000 × 1.75/1M + 500 × 14/1M = 0.00175 + 0.007
    expect(estimatedCostUsdFor(tokens, model)).toBeCloseTo(0.00875, 12);
  });

  it('uses the served config even when it is not the catalog object (a discovered deployment)', () => {
    const discovered: OpenAIModel = {
      ...model,
      id: 'GPT-5.2', // deployment-name casing
      pricing: { inputPer1M: 2, outputPer1M: 10 },
    };
    expect(estimatedCostUsdFor(tokens, discovered)).toBeCloseTo(
      (1000 * 2 + 500 * 10) / 1e6,
      12,
    );
  });

  it('never applies a deployment multiplier, even to marketplace-billed models', () => {
    const claude = OpenAIModels[OpenAIModelID.CLAUDE_SONNET_4_6];
    const pricing = claude.pricing!;
    expect(estimatedCostUsdFor(tokens, claude)).toBeCloseTo(
      (1000 * pricing.inputPer1M + 500 * pricing.outputPer1M) / 1e6,
      12,
    );
  });

  it.each([
    ['agent by modelType', { modelType: 'agent' as const }],
    ['organization agent', { isOrganizationAgent: true }],
    ['agent by id prefix', { id: 'foundry-abc' }],
    ['BYO source', { id: 'byom-x-gpt-5.2', isCustomSourceModel: true }],
    ['local runtime', { id: 'local-llama', isLocalModel: true }],
    ['no catalog price', { pricing: undefined }],
  ])('returns undefined — never 0 — for %s', (_label, patch) => {
    expect(
      estimatedCostUsdFor(tokens, { ...model, ...patch } as OpenAIModel),
    ).toBeUndefined();
  });

  it('returns undefined instead of throwing on a non-finite count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      estimatedCostUsdFor({ promptTokens: NaN, completionTokens: 5 }, model),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a zero-token call is a real $0, not "unpriced"', () => {
    expect(
      estimatedCostUsdFor({ promptTokens: 0, completionTokens: 0 }, model),
    ).toBe(0);
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
