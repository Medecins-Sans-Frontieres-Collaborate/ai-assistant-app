/** Real resolver/executor tests; only Azure provider I/O is mocked. */
import {
  AuxiliaryModelExecutor,
  AuxiliaryUnavailableError,
  auxiliaryParameters,
} from '@/lib/services/auxiliary/AuxiliaryModelExecutor';
import { isEuProcessing } from '@/lib/services/auxiliary/bindings';
import {
  auxiliaryProbeRequest,
  matchesAuxiliarySchema,
} from '@/lib/services/auxiliary/probes';
import { resolveAuxiliaryCandidate } from '@/lib/services/auxiliary/resolution';
import {
  AuxiliaryAssignmentsSchema,
  type AuxiliaryCandidate,
  type AuxiliaryInventory,
  type AuxiliaryObservation,
} from '@/lib/services/auxiliary/types';

import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ref = { accountBinding: 'EU' as const, deploymentName: 'classifier' };
const inventory = (
  overrides: Partial<AuxiliaryInventory> = {},
): AuxiliaryInventory => ({
  account: {
    binding: 'EU',
    configured: true,
    endpoint: 'https://eu.services.ai.azure.com/openai/v1/',
    resourcePath:
      '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/eu',
  },
  status: 'current',
  fetchedAt: new Date().toISOString(),
  location: 'swedencentral',
  retirementAvailable: true,
  models: [
    {
      deploymentName: 'classifier',
      modelName: 'gpt-5.4-mini',
      modelVersion: 'v1',
      publisher: 'OpenAI',
      sku: 'DataZoneStandard',
      capabilities: { chatCompletion: 'true' },
      provisioningState: 'Succeeded',
      tags: {},
    },
  ],
  ...overrides,
});
function candidate(
  overrides: Partial<AuxiliaryCandidate> = {},
): AuxiliaryCandidate {
  return {
    ...resolveAuxiliaryCandidate(ref, inventory(), 'EU').candidate!,
    ...overrides,
  };
}
const response = (content = '{"ok":true}') =>
  ({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) as OpenAI.Chat.Completions.ChatCompletion;
const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
  model: 'old-hardcoded-model',
  messages: [{ role: 'user', content: 'Synthetic test' }],
  reasoning_effort: 'minimal',
  max_completion_tokens: 256,
};
const valid = (result: OpenAI.Chat.Completions.ChatCompletion) =>
  result.choices[0]?.message.content === '{"ok":true}' ? true : undefined;
afterEach(() => vi.useRealTimers());

describe('auxiliary regional eligibility', () => {
  it.each(['GlobalStandard', 'GlobalProvisionedManaged', 'unknown'])(
    'does not infer EU residency from an EU account for %s',
    (sku) => {
      const data = inventory();
      data.models[0].sku = sku;
      expect(resolveAuxiliaryCandidate(ref, data, 'EU').status.reason).toBe(
        'residency',
      );
      expect(
        resolveAuxiliaryCandidate(ref, data, 'US').candidate,
      ).toBeDefined();
    },
  );
  it('requires explicit EU location and permits verified EU data-zone processing', () => {
    expect(isEuProcessing('eastus2', 'DataZoneStandard')).toBe(false);
    expect(isEuProcessing(undefined, 'DataZoneStandard')).toBe(false);
    expect(isEuProcessing('swedencentral', 'DataZoneStandard')).toBe(true);
    expect(
      resolveAuxiliaryCandidate(ref, inventory(), 'EU').status.eligible,
    ).toBe(true);
  });
  it('distinguishes a discovery failure from authoritative missing deployment', () => {
    expect(
      resolveAuxiliaryCandidate(ref, inventory({ models: [] }), 'EU').status
        .reason,
    ).toBe('deployment_missing');
    expect(
      resolveAuxiliaryCandidate(ref, inventory({ status: 'unavailable' }), 'EU')
        .status.reason,
    ).toBe('inventory_unavailable');
  });
  it('bounds last-known-good inventory and never trusts cached policy alone', () => {
    const data = inventory({
      status: 'stale',
      fetchedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    expect(resolveAuxiliaryCandidate(ref, data, 'EU').status.eligible).toBe(
      true,
    );
    data.fetchedAt = new Date(Date.now() - 3600_001).toISOString();
    expect(resolveAuxiliaryCandidate(ref, data, 'EU').status.reason).toBe(
      'inventory_unavailable',
    );
  });
  it('uses actual model/version facts and invalidates old compatibility on alias upgrades', () => {
    const data = inventory();
    const before = resolveAuxiliaryCandidate(ref, data, 'EU').candidate!;
    data.models[0].modelName = 'gpt-6-new-small-not-in-static-catalog';
    data.models[0].modelVersion = 'v2';
    const after = resolveAuxiliaryCandidate(ref, data, 'EU').candidate!;
    expect(after.model.id).toBe('gpt-6-new-small-not-in-static-catalog');
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(auxiliaryParameters(params, after).reasoning_effort).toBeUndefined();
  });
  it('brackets retirement before, at, and after the deadline', () => {
    const data = inventory();
    const now = Date.now();
    data.models[0].retiresAt = new Date(now + 1).toISOString();
    expect(
      resolveAuxiliaryCandidate(ref, data, 'EU', [], now).status.eligible,
    ).toBe(true);
    expect(
      resolveAuxiliaryCandidate(ref, data, 'EU', [], now + 1).status.reason,
    ).toBe('retired');
    expect(
      resolveAuxiliaryCandidate(ref, data, 'EU', [], now + 2).status.eligible,
    ).toBe(false);
  });
  it('keeps deployment eligibility separate from unknown retirement checks', () => {
    const result = resolveAuxiliaryCandidate(
      ref,
      inventory({ retirementAvailable: false }),
      'EU',
    );
    expect(result.status.retirementUnknown).toBe(true);
    expect(result.status.eligible).toBe(true);
  });
  it('rejects endpoint injection, duplicate chains, and excessive designation counts', () => {
    const chain = {
      routing: { EU: [ref], US: [ref] },
      searchAssessment: { EU: [ref], US: [ref] },
    };
    expect(AuxiliaryAssignmentsSchema.safeParse(chain).success).toBe(true);
    expect(
      AuxiliaryAssignmentsSchema.safeParse({
        ...chain,
        routing: { EU: [ref, ref], US: [ref] },
      }).success,
    ).toBe(false);
    expect(
      AuxiliaryAssignmentsSchema.safeParse({
        ...chain,
        routing: {
          EU: [{ ...ref, endpoint: 'https://attacker.invalid' }],
          US: [ref],
        },
      }).success,
    ).toBe(false);
    expect(
      AuxiliaryAssignmentsSchema.safeParse({
        ...chain,
        routing: {
          EU: Array.from({ length: 6 }, (_, i) => ({
            ...ref,
            deploymentName: `model-${i}`,
          })),
          US: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe('auxiliary shared execution', () => {
  function harness(
    targets = [
      candidate(),
      candidate({
        reference: { ...ref, deploymentName: 'fallback' },
        fingerprint: 'fallback',
        priority: 1,
      }),
    ],
  ) {
    const create = vi.fn().mockResolvedValue(response());
    const observe = vi.fn();
    const executor = new AuxiliaryModelExecutor({
      environment: 'live',
      resolve: async () => ({ candidates: targets, revision: 'r1' }),
      client: () =>
        ({ chat: { completions: { create } } }) as unknown as OpenAI,
      observe,
    });
    return { executor, create, observe };
  }
  it('calls actual deployment names and falls back on a missing primary', async () => {
    const { executor, create, observe } = harness();
    create.mockRejectedValueOnce(
      Object.assign(new Error('DeploymentNotFound'), { status: 404 }),
    );
    expect(
      await executor.execute(params, valid, {
        operation: 'skills',
        region: 'EU',
      }),
    ).toBe(true);
    expect(create.mock.calls.map(([request]) => request.model)).toEqual([
      'classifier',
      'fallback',
    ]);
    expect(observe.mock.calls[0][0]).toMatchObject({
      success: false,
      reason: 'deployment_missing',
      httpStatus: 404,
    });
    expect(observe.mock.calls[1][0]).toMatchObject({
      success: true,
      fallback: true,
    });
  });
  it('records fallback correctly when missing candidates were filtered before execution', async () => {
    const { executor, observe } = harness([candidate({ priority: 2 })]);
    await executor.execute(params, valid, {
      operation: 'skills',
      region: 'EU',
    });
    expect(observe.mock.calls[0][0].fallback).toBe(true);
  });
  it('does not repeatedly call a missing deployment while it is cooling down', async () => {
    const { executor, create } = harness();
    create.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { status: 404 }),
    );
    await executor.execute(params, valid, {
      operation: 'skills',
      region: 'EU',
    });
    create.mockClear();
    await executor.execute(params, valid, {
      operation: 'skills',
      region: 'EU',
    });
    expect(create.mock.calls.map(([request]) => request.model)).toEqual([
      'fallback',
    ]);
  });
  it('does not try every model on the same unauthorized account', async () => {
    const { executor, create } = harness();
    create.mockRejectedValue(
      Object.assign(new Error('denied'), { status: 403 }),
    );
    await expect(
      executor.execute(params, valid, { operation: 'skills', region: 'EU' }),
    ).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('falls back on malformed/truncated responses and accounts for both attempts', async () => {
    const { executor, create } = harness();
    const onUsage = vi.fn();
    create.mockResolvedValueOnce(response('bad JSON'));
    await executor.execute(params, valid, {
      operation: 'skills',
      region: 'EU',
      onUsage,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledTimes(2);
  });
  it('never falls back to bypass a safety refusal', async () => {
    const { executor, create } = harness();
    const refused = response();
    refused.choices[0].message.refusal = 'Declined';
    create.mockResolvedValue(refused);
    await expect(
      executor.execute(params, valid, { operation: 'skills', region: 'EU' }),
    ).rejects.toMatchObject({ reason: 'refused' });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('does not let usage or observation failures discard a valid response', async () => {
    const { executor, observe } = harness();
    observe.mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(
      await executor.execute(params, valid, {
        operation: 'skills',
        region: 'EU',
        onUsage: () => {
          throw new Error('sink down');
        },
      }),
    ).toBe(true);
  });
  it('limits network attempts independently of chain size', async () => {
    const targets = Array.from({ length: 5 }, (_, i) =>
      candidate({
        fingerprint: `fingerprint-${i}`,
        reference: { ...ref, deploymentName: `model-${i}` },
      }),
    );
    const { executor, create } = harness(targets);
    create.mockRejectedValue(
      Object.assign(new Error('missing'), { status: 404 }),
    );
    await expect(
      executor.execute(params, valid, { operation: 'skills', region: 'EU' }),
    ).rejects.toBeInstanceOf(AuxiliaryUnavailableError);
    expect(create).toHaveBeenCalledTimes(3);
  });
  it('respects cancellation before any provider attempt', async () => {
    const { executor, create, observe } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executor.execute(params, valid, {
        operation: 'skills',
        region: 'EU',
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
  it('bounds dependencies and attempts with one real deadline even when an SDK ignores signals', async () => {
    const { executor, create } = harness();
    create.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    await expect(
      executor.execute(params, valid, {
        operation: 'skills',
        region: 'EU',
        timeoutMs: 60,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - start).toBeLessThan(600);
  });
});

describe('synthetic operation contracts', () => {
  it.each(['skills', 'tools', 'trim', 'assessment'] as const)(
    'builds the real %s schema with bounded synthetic input',
    async (operation) => {
      const request = await auxiliaryProbeRequest(operation);
      expect(request.response_format?.type).toBe('json_schema');
      expect(JSON.stringify(request.messages).toLowerCase()).toContain(
        'synthetic',
      );
    },
  );
  it('rejects wrong types, missing fields, unknown properties, enum escapes and excessive arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string', enum: ['allowed'] },
          maxItems: 1,
        },
      },
      required: ['ids'],
      additionalProperties: false,
    };
    expect(matchesAuxiliarySchema({ ids: ['allowed'] }, schema)).toBe(true);
    for (const value of [
      {},
      { ids: 'allowed' },
      { ids: ['escaped'] },
      { ids: ['allowed', 'allowed'] },
      { ids: [], extra: true },
    ])
      expect(matchesAuxiliarySchema(value, schema)).toBe(false);
  });
});
