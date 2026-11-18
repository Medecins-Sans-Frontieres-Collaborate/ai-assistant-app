/**
 * Turn routing for helper-model calls: the residency region, the
 * chat-model fallback bindings (text and structured), and cancellation.
 */
import { auxiliaryTurnRouting } from '@/lib/services/chat/auxiliaryTurnRouting';

import { createTestChatContext } from './testUtils';

import { describe, expect, it, vi } from 'vitest';

function contextFor(region: unknown, hostedRegion?: 'US' | 'EU') {
  const context = createTestChatContext();
  context.user = { ...context.user, region } as typeof context.user;
  context.hostedRegion = hostedRegion;
  return context;
}

describe('auxiliaryTurnRouting', () => {
  it.each([
    ['an EU user', 'EU', undefined, 'EU'],
    ['an EU user asking for US hosting', 'EU', 'US', 'EU'],
    ['a US user', 'US', undefined, 'US'],
    ['a US user asking for EU hosting', 'US', 'EU', 'EU'],
    ['a user with no known region', undefined, undefined, 'EU'],
  ] as const)(
    'routes %s to %s',
    (_label, userRegion, hostedRegion, expected) => {
      const routing = auxiliaryTurnRouting(
        contextFor(userRegion, hostedRegion),
      );
      expect(routing.region).toBe(expected);
    },
  );

  it("binds the fallback to the turn's model, region and user", async () => {
    const completeText = vi.fn(async () => 'query');
    const context = contextFor('EU');

    const routing = auxiliaryTurnRouting(context, { completeText });
    await routing.textFallback!({
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 10,
    });

    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({ model: context.model, userRegion: 'EU' }),
      expect.objectContaining({ user: context.user }),
      undefined,
    );
  });

  it('has no fallback without a provider', () => {
    expect(auxiliaryTurnRouting(contextFor('US')).textFallback).toBe(undefined);
  });

  it('drops the fallback (not the search) for a custom-source model missing its endpoint', () => {
    const context = createTestChatContext({
      model: { id: 'byom', isCustomSourceModel: true } as never,
    });

    const routing = auxiliaryTurnRouting(context, {
      completeText: vi.fn(),
    });

    expect(routing.textFallback).toBeUndefined();
    expect(routing.structuredFallback).toBeUndefined();
    expect(routing.region).toBe('US');
  });

  it('carries the stage signal so a stage timeout cancels the rewrite', () => {
    const context = contextFor('US');
    const stage = new AbortController();
    context.stageSignal = stage.signal;

    expect(auxiliaryTurnRouting(context).signal).toBe(stage.signal);
  });

  it('binds the structured fallback to the turn model and residency', async () => {
    const completeStructuredDecision = vi.fn(async () => ({
      text: '{}',
      model: {} as never,
      region: 'EU' as const,
    }));
    const context = contextFor('EU', 'US');

    const routing = auxiliaryTurnRouting(context, {
      completeStructuredDecision,
    });
    await routing.structuredFallback!({ model: '', messages: [] });

    expect(completeStructuredDecision).toHaveBeenCalledWith(
      { model: context.model, userRegion: 'EU', hostedRegion: 'US' },
      { model: '', messages: [] },
      undefined,
    );
    // Only the structured provider was given: no text fallback.
    expect(routing.textFallback).toBeUndefined();
  });

  it('offers no structured fallback for a custom-source model', () => {
    const context = createTestChatContext({
      model: { id: 'byom', isCustomSourceModel: true } as never,
    });
    expect(
      auxiliaryTurnRouting(context, { completeStructuredDecision: vi.fn() })
        .structuredFallback,
    ).toBeUndefined();
  });
});
