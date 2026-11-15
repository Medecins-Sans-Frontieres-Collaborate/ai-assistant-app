import { fireEvent, render, screen, within } from '@testing-library/react';

import { EMISSIONS_ASSUMPTIONS } from '@/lib/utils/shared/emissions';
import {
  DEFAULT_USAGE_BUDGETS,
  UsageBudget,
  budgetLimit,
  localDayKey,
} from '@/lib/utils/shared/usageBudgets';
import { sumUsageImpact } from '@/lib/utils/shared/usageImpact';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { BudgetBars } from '@/components/Emissions/BudgetBars';
import { UsageBudgetsSetting } from '@/components/Settings/UsageBudgetsSetting';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const MODELS = Object.values(OpenAIModels);
const BUCKET_KEY = `${OpenAIModelID.GPT_5_MINI}|default|none`;
const BUCKET = { promptTokens: 40_000, completionTokens: 20_000, requests: 12 };
const USED_GRAMS = sumUsageImpact({ [BUCKET_KEY]: BUCKET }, MODELS).gCO2e;

const emissions = () => useSettingsStore.getState().usageBudgets.emissions;
const card = (metric: 'emissions' | 'cost') =>
  within(screen.getByTestId(`usage-budget-${metric}`));
/** The "measure it as" button for one unit of the emissions budget. */
const unitButton = (unit: string): HTMLElement => {
  const button = screen
    .getByTestId('usage-budget-emissions')
    .querySelector<HTMLElement>(`[data-unit="${unit}"]`);
  if (!button) throw new Error(`No unit button for "${unit}"`);
  return button;
};

const enabledEmissions = (change: Partial<UsageBudget> = {}) =>
  useSettingsStore.setState({
    usageBudgets: {
      ...DEFAULT_USAGE_BUDGETS,
      emissions: {
        ...DEFAULT_USAGE_BUDGETS.emissions,
        enabled: true,
        ...change,
      },
    },
  });

describe('UsageBudgetsSetting', () => {
  beforeEach(() => {
    delete mockFlags.showUsageImpact;
    delete mockFlags.showUsageCost;
    useSettingsStore.setState({
      models: MODELS,
      usageBudgets: DEFAULT_USAGE_BUDGETS,
      dailyTokenUsage: { [localDayKey(new Date())]: { [BUCKET_KEY]: BUCKET } },
    });
  });

  it('starts with both budgets off and no controls shown', () => {
    render(<UsageBudgetsSetting />);
    expect(card('emissions').getByText('usageBudgets.off')).toBeInTheDocument();
    expect(card('cost').getByText('usageBudgets.off')).toBeInTheDocument();
    expect(screen.queryByTestId('budget-meter')).not.toBeInTheDocument();
  });

  it('switches a budget on and shows its meter', () => {
    render(<UsageBudgetsSetting />);
    fireEvent.click(card('emissions').getAllByRole('checkbox')[0]);
    expect(emissions().enabled).toBe(true);
    expect(card('emissions').getByTestId('budget-meter')).toBeInTheDocument();
    // The other budget is untouched.
    expect(useSettingsStore.getState().usageBudgets.cost.enabled).toBe(false);
  });

  it('offers every equivalent activity as a unit and keeps the carbon when switching', () => {
    enabledEmissions({ amount: 5, unit: 'netflixHd' });
    render(<UsageBudgetsSetting />);
    const before = budgetLimit(emissions());
    for (const activity of Object.keys(
      EMISSIONS_ASSUMPTIONS.equivalences.activityGramsPerHour,
    )) {
      expect(unitButton(activity)).toBeInTheDocument();
    }

    fireEvent.click(unitButton('zoomCall'));
    expect(emissions().unit).toBe('zoomCall');
    // The amount is re-expressed (to one decimal), not carried over as "5".
    expect(emissions().amount).not.toBe(5);
    expect(budgetLimit(emissions())).toBeCloseTo(before, -1);

    fireEvent.click(unitButton('grams'));
    expect(emissions().unit).toBe('grams');
    expect(budgetLimit(emissions())).toBeCloseTo(before, -1);
  });

  it('commits a typed amount on blur, not on every keystroke', () => {
    enabledEmissions({ amount: 5, unit: 'netflixHd' });
    render(<UsageBudgetsSetting />);
    const field = card('emissions').getByLabelText('usageBudgets.amountLabel');
    fireEvent.change(field, { target: { value: '12' } });
    expect(emissions().amount).toBe(5);
    fireEvent.blur(field);
    expect(emissions().amount).toBe(12);
  });

  it('restores the field when the typed amount is not a number', () => {
    enabledEmissions({ amount: 5, unit: 'netflixHd' });
    render(<UsageBudgetsSetting />);
    const field = card('emissions').getByLabelText(
      'usageBudgets.amountLabel',
    ) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(emissions().amount).toBe(5);
    expect(field.value).toBe('5');
  });

  it('changes the period', () => {
    enabledEmissions();
    render(<UsageBudgetsSetting />);
    fireEvent.click(
      card('emissions').getByRole('button', {
        name: 'usageBudgets.period.week',
      }),
    );
    expect(emissions().period).toBe('week');
  });

  it('toggles a stage without touching the others', () => {
    enabledEmissions();
    render(<UsageBudgetsSetting />);
    const stop = within(screen.getByTestId('usage-budget-emissions-stop'));
    expect(emissions().stages.stop.enabled).toBe(false);
    fireEvent.click(stop.getByRole('checkbox'));
    expect(emissions().stages).toMatchObject({
      warn: { enabled: true },
      ask: { enabled: true },
      stop: { enabled: true },
    });
  });

  it('keeps thresholds in escalation order when one is moved past another', () => {
    enabledEmissions();
    render(<UsageBudgetsSetting />);
    const warn = within(
      screen.getByTestId('usage-budget-emissions-warn'),
    ).getByRole('spinbutton');
    fireEvent.change(warn, { target: { value: '140' } });
    fireEvent.blur(warn);
    const { stages } = emissions();
    expect(stages.warn.percent).toBe(140);
    expect(stages.ask.percent).toBe(140);
    expect(stages.stop.percent).toBe(140);
    // The neighbours' fields follow the stored value.
    expect(
      (
        within(screen.getByTestId('usage-budget-emissions-ask')).getByRole(
          'spinbutton',
        ) as HTMLInputElement
      ).value,
    ).toBe('140');
  });

  it('has no cost card when the tenant hides cost figures', () => {
    mockFlags.showUsageCost = false;
    render(<UsageBudgetsSetting />);
    expect(screen.getByTestId('usage-budget-emissions')).toBeInTheDocument();
    expect(screen.queryByTestId('usage-budget-cost')).not.toBeInTheDocument();
  });
});

describe('BudgetBars', () => {
  const status = (percent: number, state: 'ok' | 'warn' | 'ask' | 'stop') => ({
    metric: 'emissions' as const,
    budget: DEFAULT_USAGE_BUDGETS.emissions,
    limit: 100,
    used: percent,
    percent,
    state,
    periodKey: '2026-11-01',
    resetsAt: new Date(2026, 11, 1),
  });

  it('renders nothing without an active budget', () => {
    const { container } = render(<BudgetBars statuses={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fills to the share of the budget used and is full once it is met', () => {
    const { rerender } = render(<BudgetBars statuses={[status(82, 'warn')]} />);
    expect(screen.getByTestId('budget-bar-emissions')).toHaveStyle({
      width: '82%',
    });
    rerender(<BudgetBars statuses={[status(130, 'stop')]} />);
    expect(screen.getByTestId('budget-bar-emissions')).toHaveStyle({
      width: '100%',
    });
  });

  it('changes colour with the stage', () => {
    const classFor = (state: 'ok' | 'warn' | 'ask' | 'stop') => {
      const { unmount } = render(<BudgetBars statuses={[status(50, state)]} />);
      const className = screen.getByTestId('budget-bar-emissions').className;
      unmount();
      return className;
    };
    const classes = (['ok', 'warn', 'ask', 'stop'] as const).map(classFor);
    expect(new Set(classes).size).toBe(4);
  });

  it('is hidden from assistive technology', () => {
    render(<BudgetBars statuses={[status(82, 'warn')]} />);
    expect(screen.getByTestId('budget-bars')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    // USED_GRAMS keeps the fixture honest: the bucket really has a footprint.
    expect(USED_GRAMS).toBeGreaterThan(0);
  });
});
