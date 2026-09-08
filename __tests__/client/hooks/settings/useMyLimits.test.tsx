import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import {
  MyLimitsResponse,
  formatResetIn,
  useLimitGates,
  useModelAvailability,
  useMyLimits,
  useResetCountdown,
} from '@/client/hooks/settings/useMyLimits';

import { OpenAIModel, OpenAIModelID } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable flag holder so each test picks the LD state it needs.
const flags = vi.hoisted(() => ({ usageLimits: undefined as unknown }));
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => ({ usageLimits: flags.usageLimits }),
}));

const model = (id: string): OpenAIModel => ({
  id: id as OpenAIModelID,
  name: id,
  maxLength: 1,
  tokenLimit: 1,
});

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

function okResponse(body: Partial<MyLimitsResponse>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        enabled: true,
        mode: 'enforce',
        policyUnavailable: false,
        limits: [],
        ...body,
      },
    }),
  };
}

describe('useMyLimits', () => {
  const settingsInitial = useSettingsStore.getState();

  beforeEach(() => {
    flags.usageLimits = true;
    useSettingsStore.setState(settingsInitial, true);
    // Catalog ids out of order + one non-catalog id the server would skip.
    useSettingsStore
      .getState()
      .setModels([
        model('gpt-5.2'),
        model('byom-abc'),
        model(OpenAIModelID.GPT_4_1),
      ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches /api/limits/me with usage=1 and the sorted catalog ids', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchSpy);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useMyLimits(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(fetchSpy.mock.calls[0][0] as string, 'http://x');
    expect(url.pathname).toBe('/api/limits/me');
    expect(url.searchParams.get('usage')).toBe('1');
    // sorted, catalog-only: byom-abc dropped
    expect(url.searchParams.get('models')).toBe(
      ['gpt-5.2', OpenAIModelID.GPT_4_1].sort().join(','),
    );
    expect(result.current.enforce).toBe(true);
  });

  it('does not fetch at all when the usageLimits flag is off (fail open)', async () => {
    flags.usageLimits = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useMyLimits(), { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.enforce).toBe(false);
    expect(result.current.limits).toEqual([]);
    expect(result.current.models).toEqual({});
  });

  it('waits for the model list before fetching (no throwaway request)', async () => {
    useSettingsStore.getState().setModels([]);
    const fetchSpy = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchSpy);
    const { Wrapper } = makeWrapper();

    renderHook(() => useMyLimits(), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      useSettingsStore.getState().setModels([model('gpt-5.2')]);
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });

  it('reads enforce=false in observe mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ mode: 'observe' })),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useMyLimits(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.mode).toBe('observe');
    expect(result.current.enforce).toBe(false);
  });

  it('reads enforce=false when the policy is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ policyUnavailable: true, usageUnavailable: true }),
        ),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useMyLimits(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.policyUnavailable).toBe(true);
    expect(result.current.usageUnavailable).toBe(true);
    expect(result.current.enforce).toBe(false);
  });

  it('treats a 401 as "nothing limited" rather than an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useMyLimits(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.enforce).toBe(false);
    expect(result.current.isLimited).toBe(false);
  });

  it('fails open on a failed fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useMyLimits(), { wrapper: Wrapper });

    // retry: 1 → the error state lands after React Query's 1 s retry delay
    await waitFor(() => expect(result.current.error).not.toBeNull(), {
      timeout: 4000,
    });
    expect(result.current.enforce).toBe(false);
    expect(result.current.limits).toEqual([]);
  });
});

describe('useModelAvailability', () => {
  const settingsInitial = useSettingsStore.getState();
  const models: MyLimitsResponse['models'] = {
    'gpt-5.2': { allowed: true },
    o3: { allowed: false, reason: 'blocked' },
    [OpenAIModelID.GPT_4_1]: {
      allowed: true,
      reason: 'exhausted',
      limit: 20,
      used: 20,
      remaining: 0,
      resetAt: '2030-01-01T00:00:00.000Z',
    },
    'claude-x': { allowed: true, reason: 'familyExhausted', remaining: 0 },
    'legacy-zero': { allowed: true, remaining: 0 },
  };

  beforeEach(() => {
    flags.usageLimits = true;
    useSettingsStore.setState(settingsInitial, true);
    useSettingsStore.getState().setModels([model('gpt-5.2')]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderAvailability = (
    id: string | undefined,
    body: Partial<MyLimitsResponse>,
  ) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)));
    const { Wrapper } = makeWrapper();
    return renderHook(() => useModelAvailability(id), { wrapper: Wrapper });
  };

  it('reports blocked / exhausted / familyExhausted / available', async () => {
    const blocked = renderAvailability('o3', { models });
    await waitFor(() => expect(blocked.result.current.state).toBe('blocked'));
    expect(blocked.result.current.reason).toBe('blocked');

    const exhausted = renderAvailability(OpenAIModelID.GPT_4_1, { models });
    await waitFor(() =>
      expect(exhausted.result.current.state).toBe('exhausted'),
    );
    expect(exhausted.result.current).toMatchObject({
      reason: 'exhausted',
      limit: 20,
      used: 20,
      remaining: 0,
      resetAt: '2030-01-01T00:00:00.000Z',
    });

    const family = renderAvailability('claude-x', { models });
    await waitFor(() => expect(family.result.current.state).toBe('exhausted'));
    expect(family.result.current.reason).toBe('familyExhausted');

    const legacy = renderAvailability('legacy-zero', { models });
    await waitFor(() => expect(legacy.result.current.state).toBe('exhausted'));

    const fine = renderAvailability('gpt-5.2', { models });
    await waitFor(() => expect(fine.result.current.state).toBe('available'));
  });

  it('fails open for an id absent from the payload and for no id', async () => {
    const unknown = renderAvailability('not-in-payload', { models });
    await new Promise((r) => setTimeout(r, 0));
    expect(unknown.result.current.state).toBe('available');

    const none = renderAvailability(undefined, { models });
    expect(none.result.current.state).toBe('available');
  });

  it('fails open in observe mode, on policyUnavailable and with the flag off', async () => {
    const observe = renderAvailability('o3', { models, mode: 'observe' });
    await new Promise((r) => setTimeout(r, 0));
    expect(observe.result.current.state).toBe('available');

    const outage = renderAvailability('o3', {
      models,
      policyUnavailable: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(outage.result.current.state).toBe('available');

    flags.usageLimits = false;
    const off = renderAvailability('o3', { models });
    await new Promise((r) => setTimeout(r, 0));
    expect(off.result.current.state).toBe('available');
  });
});

describe('useLimitGates', () => {
  const settingsInitial = useSettingsStore.getState();
  const limits: MyLimitsResponse['limits'] = [
    {
      limitKey: 'feature.webSearch.enabled',
      value: false,
      unit: 'boolean',
      window: 'total',
      source: 'override',
    },
    {
      limitKey: 'feature.webSearch.callsPerDay',
      value: 10,
      unit: 'count',
      window: 'day',
      source: 'default',
      used: 8,
      remaining: 2,
      resetAt: '2030-01-01T00:00:00.000Z',
    },
    // Model-qualified: must never read as the global gate.
    {
      limitKey: 'feature.codeInterpreter.enabled',
      value: false,
      unit: 'boolean',
      window: 'total',
      source: 'override',
      modelId: 'gpt-5.2',
    },
  ];

  beforeEach(() => {
    flags.usageLimits = true;
    useSettingsStore.setState(settingsInitial, true);
    useSettingsStore.getState().setModels([model('gpt-5.2')]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads boolean gates and counter rows from limits when enforced', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ limits })));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useLimitGates(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.enforce).toBe(true));
    expect(result.current.isFeatureBlocked('feature.webSearch.enabled')).toBe(
      true,
    );
    expect(result.current.isFeatureBlocked('feature.mcp.enabled')).toBe(false);
    expect(
      result.current.isFeatureBlocked('feature.codeInterpreter.enabled'),
    ).toBe(false);
    expect(
      result.current.featureRemaining('feature.webSearch.callsPerDay'),
    ).toEqual({
      remaining: 2,
      limit: 10,
      used: 8,
      resetAt: '2030-01-01T00:00:00.000Z',
    });
    expect(
      result.current.featureRemaining('feature.codeInterpreter.runsPerDay'),
    ).toBeUndefined();
  });

  it('fails open in observe mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ limits, mode: 'observe' })),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useLimitGates(), { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.enforce).toBe(false);
    expect(result.current.isFeatureBlocked('feature.webSearch.enabled')).toBe(
      false,
    );
    expect(
      result.current.featureRemaining('feature.webSearch.callsPerDay'),
    ).toBeUndefined();
  });
});

describe('formatResetIn', () => {
  const now = Date.parse('2026-09-08T10:00:00.000Z');

  it('picks minutes, hours and days, rounding up', () => {
    expect(formatResetIn('2026-09-08T10:00:30.000Z', now, 'en')).toBe(
      'in 1 minute',
    );
    expect(formatResetIn('2026-09-08T10:12:00.000Z', now, 'en')).toBe(
      'in 12 minutes',
    );
    expect(formatResetIn('2026-09-08T16:12:00.000Z', now, 'en')).toBe(
      'in 7 hours',
    );
    expect(formatResetIn('2026-09-11T10:00:00.000Z', now, 'en')).toBe(
      'in 3 days',
    );
  });

  it('returns null when past or unparseable', () => {
    expect(formatResetIn('2026-09-08T09:59:59.000Z', now, 'en')).toBeNull();
    expect(formatResetIn('garbage', now, 'en')).toBeNull();
  });
});

describe('useResetCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null without a resetAt', () => {
    const { result } = renderHook(() => useResetCountdown(undefined));
    expect(result.current).toBeNull();
  });

  it('ticks once a minute and fires onExpired exactly once when it passes', () => {
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useResetCountdown('2026-09-08T10:02:00.000Z', { onExpired }),
    );

    expect(result.current).toBe('in 2 minutes');
    expect(onExpired).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe('in 1 minute');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(1);

    // Further ticks must not re-fire.
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onExpired for a resetAt already past on mount', () => {
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useResetCountdown('2026-09-08T09:00:00.000Z', { onExpired }),
    );

    expect(result.current).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('re-arms when resetAt changes to a new future instant', () => {
    const onExpired = vi.fn();
    const { result, rerender } = renderHook(
      ({ resetAt }: { resetAt: string }) =>
        useResetCountdown(resetAt, { onExpired }),
      { initialProps: { resetAt: '2026-09-08T10:01:00.000Z' } },
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(1);

    rerender({ resetAt: '2026-09-08T10:03:00.000Z' });
    expect(result.current).toBe('in 2 minutes');

    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(result.current).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(2);
  });
});
