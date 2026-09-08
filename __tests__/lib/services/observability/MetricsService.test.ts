/**
 * MetricsService.recordTokenUsage — the OTel side of the token sink.
 * Contract under test (design §4d): the service owns NO price table; the
 * `tokens.cost` histogram is recorded exactly when the caller supplies a
 * finite `estimatedCostUsd` (a real $0 included), and never otherwise — an
 * unpriceable call must not show up as a $0 request in Azure Monitor. Token
 * counters are unaffected either way.
 */
import { Session } from 'next-auth';

import { MetricsService } from '@/lib/services/observability/MetricsService';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const instruments = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  return { counters, histograms };
});

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: (name: string) => {
        const counter = { add: vi.fn() };
        instruments.counters.set(name, counter);
        return counter;
      },
      createHistogram: (name: string) => {
        const histogram = { record: vi.fn() };
        instruments.histograms.set(name, histogram);
        return histogram;
      },
    }),
  },
}));

const user = {
  id: 'u1',
  mail: 'u1@example.com',
  department: 'Ops',
} as Session['user'];
const context = { user, model: 'gpt-5.2', operation: 'chat' as const };

const cost = () => instruments.histograms.get('tokens.cost')!;
const tokens = () => instruments.counters.get('tokens.usage')!;

describe('MetricsService.recordTokenUsage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    cost().record.mockClear();
    tokens().add.mockClear();
  });

  it('records the supplied estimate on tokens.cost with the usage attributes', () => {
    MetricsService.recordTokenUsage(
      { prompt: 10, completion: 5, total: 15, estimatedCostUsd: 0.0000875 },
      { ...context, botId: 'msf_communications' },
    );
    expect(cost().record).toHaveBeenCalledTimes(1);
    const [value, attributes] = cost().record.mock.calls[0];
    expect(value).toBeCloseTo(0.0000875, 12);
    expect(attributes).toMatchObject({
      'user.id': 'u1',
      'user.department': 'Ops',
      'model.id': 'gpt-5.2',
      'operation.type': 'chat',
      'bot.id': 'msf_communications',
    });
  });

  it('records a genuine $0 estimate (a zero-token call is priced, not unknown)', () => {
    MetricsService.recordTokenUsage({ total: 0, estimatedCostUsd: 0 }, context);
    expect(cost().record).toHaveBeenCalledWith(0, expect.any(Object));
  });

  it.each([
    ['absent', {}],
    ['undefined', { estimatedCostUsd: undefined }],
    ['NaN', { estimatedCostUsd: Number.NaN }],
    ['Infinity', { estimatedCostUsd: Number.POSITIVE_INFINITY }],
  ])(
    'records NO cost when the estimate is %s — and no internal fallback prices the model',
    (_label, extra) => {
      MetricsService.recordTokenUsage(
        { prompt: 10, completion: 5, total: 15, ...extra },
        { ...context, model: 'gpt-4.1' },
      );
      expect(cost().record).not.toHaveBeenCalled();
      // Tokens still flow.
      expect(tokens().add).toHaveBeenCalledWith(
        15,
        expect.objectContaining({ 'token.type': 'total' }),
      );
    },
  );

  it('has no price table of its own (estimateCost is gone)', () => {
    expect(
      (MetricsService as unknown as Record<string, unknown>).estimateCost,
    ).toBeUndefined();
  });

  it('adds prompt and completion counters only when present', () => {
    MetricsService.recordTokenUsage({ total: 7 }, context);
    expect(tokens().add).toHaveBeenCalledTimes(1);
    tokens().add.mockClear();
    MetricsService.recordTokenUsage(
      { prompt: 4, completion: 3, total: 7 },
      context,
    );
    expect(tokens().add).toHaveBeenCalledTimes(3);
  });
});
