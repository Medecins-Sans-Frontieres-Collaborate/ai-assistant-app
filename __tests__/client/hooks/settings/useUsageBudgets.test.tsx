import { act, renderHook } from '@testing-library/react';

import {
  useBudgetGate,
  useUsageBudgetsStatus,
} from '@/client/hooks/settings/useUsageBudgets';

import {
  DEFAULT_USAGE_BUDGETS,
  UsageBudget,
  localDayKey,
} from '@/lib/utils/shared/usageBudgets';
import { sumUsageImpact } from '@/lib/utils/shared/usageImpact';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useBudgetGateStore } from '@/client/stores/budgetGateStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const MODELS = Object.values(OpenAIModels);
const BUCKET_KEY = `${OpenAIModelID.GPT_5_MINI}|default|none`;
const BUCKET = { promptTokens: 40_000, completionTokens: 20_000, requests: 12 };
/** What the fixture bucket costs, by the same routine the hook uses. */
const USED = sumUsageImpact({ [BUCKET_KEY]: BUCKET }, MODELS);

/**
 * An emissions budget in grams sized so the fixture usage sits at exactly
 * `percent` of it — the thresholds below are then stated in the test, not
 * derived from the emissions assumptions.
 */
const emissionsAt = (
  percent: number,
  change: Partial<UsageBudget> = {},
): UsageBudget => ({
  enabled: true,
  amount: USED.gCO2e / (percent / 100),
  unit: 'grams',
  period: 'month',
  stages: {
    warn: { enabled: true, percent: 80 },
    ask: { enabled: true, percent: 100 },
    stop: { enabled: true, percent: 125 },
  },
  ...change,
});

const setBudgets = (
  emissions: UsageBudget,
  cost = DEFAULT_USAGE_BUDGETS.cost,
) => useSettingsStore.setState({ usageBudgets: { emissions, cost } });

describe('useUsageBudgetsStatus', () => {
  beforeEach(() => {
    delete mockFlags.showUsageImpact;
    delete mockFlags.showUsageCost;
    useSettingsStore.setState({
      models: MODELS,
      usageBudgets: DEFAULT_USAGE_BUDGETS,
      dailyTokenUsage: { [localDayKey(new Date())]: { [BUCKET_KEY]: BUCKET } },
      usageBudgetAskSnoozedDay: null,
      usageBudgetWarnDismissed: {},
    });
    useBudgetGateStore.setState({ pending: null });
  });

  it('reports nothing while no budget is switched on', () => {
    const { result } = renderHook(() => useUsageBudgetsStatus());
    expect(result.current.active).toEqual([]);
    expect(result.current.state).toBe('ok');
    expect(result.current.leading).toBeNull();
  });

  it.each([
    [70, 'ok'],
    [82, 'warn'],
    [101, 'ask'],
    [130, 'stop'],
  ] as const)('usage at %s%% of the budget is %s', (percent, state) => {
    setBudgets(emissionsAt(percent));
    const { result } = renderHook(() => useUsageBudgetsStatus());
    expect(result.current.state).toBe(state);
    expect(result.current.active[0].percent).toBeCloseTo(percent);
  });

  it('counts only usage inside the budget period', () => {
    const lastYear = `${new Date().getFullYear() - 1}-01-01`;
    useSettingsStore.setState({
      dailyTokenUsage: { [lastYear]: { [BUCKET_KEY]: BUCKET } },
    });
    setBudgets(emissionsAt(130));
    const { result } = renderHook(() => useUsageBudgetsStatus());
    expect(result.current.active[0].used).toBe(0);
    expect(result.current.state).toBe('ok');
  });

  it('leads with the more severe budget, emissions winning a tie', () => {
    const cost: UsageBudget = {
      ...emissionsAt(100),
      unit: 'usd',
      amount: USED.usd / 1.3, // 130% → stop
    };
    setBudgets(emissionsAt(82), cost);
    const { result } = renderHook(() => useUsageBudgetsStatus());
    expect(result.current.state).toBe('stop');
    expect(result.current.leading?.metric).toBe('cost');

    act(() => setBudgets(emissionsAt(130), cost));
    expect(result.current.leading?.metric).toBe('emissions');
  });

  it('ignores a budget whose figures the tenant hides', () => {
    const cost: UsageBudget = {
      ...emissionsAt(100),
      unit: 'usd',
      amount: USED.usd / 1.3,
    };
    setBudgets(emissionsAt(130), cost);

    mockFlags.showUsageCost = false;
    const costHidden = renderHook(() => useUsageBudgetsStatus());
    expect(costHidden.result.current.active.map((s) => s.metric)).toEqual([
      'emissions',
    ]);

    mockFlags.showUsageImpact = false;
    const allHidden = renderHook(() => useUsageBudgetsStatus());
    expect(allHidden.result.current.active).toEqual([]);
    expect(allHidden.result.current.state).toBe('ok');
  });
});

describe('useBudgetGate', () => {
  beforeEach(() => {
    delete mockFlags.showUsageImpact;
    delete mockFlags.showUsageCost;
    useSettingsStore.setState({
      models: MODELS,
      usageBudgets: DEFAULT_USAGE_BUDGETS,
      dailyTokenUsage: { [localDayKey(new Date())]: { [BUCKET_KEY]: BUCKET } },
      usageBudgetAskSnoozedDay: null,
    });
    useBudgetGateStore.setState({ pending: null });
  });

  it('runs the action straight away below the ask stage', () => {
    setBudgets(emissionsAt(82));
    const { result } = renderHook(() => useBudgetGate());
    const action = vi.fn();
    let ran = false;
    act(() => {
      ran = result.current.guard(action);
    });
    expect(ran).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.isHolding).toBe(false);
  });

  it('holds the action at the ask stage until it is confirmed', () => {
    setBudgets(emissionsAt(101));
    const { result } = renderHook(() => useBudgetGate());
    const action = vi.fn();
    let ran = true;
    act(() => {
      ran = result.current.guard(action);
    });
    expect(ran).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(result.current.isHolding).toBe(true);

    act(() => useBudgetGateStore.getState().confirm());
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.isHolding).toBe(false);
  });

  it('drops a held action on cancel', () => {
    setBudgets(emissionsAt(101));
    const { result } = renderHook(() => useBudgetGate());
    const action = vi.fn();
    act(() => {
      result.current.guard(action);
    });
    act(() => useBudgetGateStore.getState().cancel());
    expect(action).not.toHaveBeenCalled();
    expect(result.current.isHolding).toBe(false);
  });

  it('stops asking for the rest of the day once snoozed, and only that day', () => {
    setBudgets(emissionsAt(101));
    useSettingsStore.setState({
      usageBudgetAskSnoozedDay: localDayKey(new Date()),
    });
    const today = renderHook(() => useBudgetGate());
    const action = vi.fn();
    act(() => {
      today.result.current.guard(action);
    });
    expect(action).toHaveBeenCalledTimes(1);

    useSettingsStore.setState({ usageBudgetAskSnoozedDay: '2000-01-01' });
    const otherDay = renderHook(() => useBudgetGate());
    act(() => {
      otherDay.result.current.guard(action);
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(otherDay.result.current.isHolding).toBe(true);
  });

  it('refuses a message at the stop stage, snoozed or not', () => {
    setBudgets(emissionsAt(130));
    useSettingsStore.setState({
      usageBudgetAskSnoozedDay: localDayKey(new Date()),
    });
    const { result } = renderHook(() => useBudgetGate());
    const action = vi.fn();
    let ran = true;
    act(() => {
      ran = result.current.guard(action);
    });
    expect(ran).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(result.current.isStopped).toBe(true);
    // Nothing to confirm: the composer is disabled and already says why.
    expect(result.current.isHolding).toBe(false);
  });

  it('holds a refused run so the run dialog can explain it', () => {
    setBudgets(emissionsAt(130));
    const { result } = renderHook(() => useBudgetGate());
    const action = vi.fn();
    act(() => {
      result.current.guard(action, 'run');
    });
    expect(action).not.toHaveBeenCalled();
    expect(useBudgetGateStore.getState().pending?.kind).toBe('run');
  });
});

describe('settings store usage ledger', () => {
  beforeEach(() => {
    useSettingsStore.setState({ dailyTokenUsage: {}, tokenUsageStats: {} });
  });

  it('records each request under today as well as in the lifetime totals', () => {
    const usage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      modelId: OpenAIModelID.GPT_5_MINI,
      region: null,
    };
    useSettingsStore.getState().recordTokenUsage(usage);
    useSettingsStore.getState().recordTokenUsage(usage);
    const state = useSettingsStore.getState();
    expect(state.tokenUsageStats[BUCKET_KEY].requests).toBe(2);
    expect(state.dailyTokenUsage[localDayKey(new Date())][BUCKET_KEY]).toEqual({
      promptTokens: 200,
      completionTokens: 100,
      requests: 2,
    });
  });

  it('clears the ledger with the rest of the usage stats', () => {
    useSettingsStore.setState({
      dailyTokenUsage: { '2026-11-15': { [BUCKET_KEY]: BUCKET } },
    });
    useSettingsStore.getState().resetTokenUsageStats();
    expect(useSettingsStore.getState().dailyTokenUsage).toEqual({});
  });

  it('keeps stage thresholds ordered when a budget is edited', () => {
    useSettingsStore.setState({ usageBudgets: DEFAULT_USAGE_BUDGETS });
    useSettingsStore.getState().setUsageBudget('emissions', {
      stages: {
        warn: { enabled: true, percent: 300 },
        ask: { enabled: true, percent: 100 },
        stop: { enabled: true, percent: 125 },
      },
    });
    const { warn, ask, stop } =
      useSettingsStore.getState().usageBudgets.emissions.stages;
    expect(warn.percent).toBeLessThanOrEqual(ask.percent);
    expect(ask.percent).toBeLessThanOrEqual(stop.percent);
  });
});
