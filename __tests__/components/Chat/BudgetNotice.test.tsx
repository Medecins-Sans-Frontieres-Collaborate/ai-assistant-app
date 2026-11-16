import { fireEvent, render, screen } from '@testing-library/react';

import {
  DEFAULT_USAGE_BUDGETS,
  UsageBudget,
  localDayKey,
  periodStart,
} from '@/lib/utils/shared/usageBudgets';
import { sumUsageImpact } from '@/lib/utils/shared/usageImpact';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { BudgetNotice } from '@/components/Chat/BudgetNotice';
import { SettingsSection } from '@/components/Settings/types';

import { useBudgetGateStore } from '@/client/stores/budgetGateStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const MODELS = Object.values(OpenAIModels);
const BUCKET_KEY = `${OpenAIModelID.GPT_5_MINI}|default|none`;
const BUCKET = { promptTokens: 40_000, completionTokens: 20_000, requests: 12 };
const USED_GRAMS = sumUsageImpact({ [BUCKET_KEY]: BUCKET }, MODELS).gCO2e;

/** Emissions budget sized so the fixture usage is `percent` of it. */
const setEmissionsAt = (percent: number) => {
  const emissions: UsageBudget = {
    enabled: true,
    amount: USED_GRAMS / (percent / 100),
    unit: 'grams',
    period: 'month',
    stages: {
      warn: { enabled: true, percent: 80 },
      ask: { enabled: true, percent: 100 },
      stop: { enabled: true, percent: 125 },
    },
  };
  useSettingsStore.setState({
    usageBudgets: { emissions, cost: DEFAULT_USAGE_BUDGETS.cost },
  });
};

describe('BudgetNotice', () => {
  const onChooseModel = vi.fn();

  beforeEach(() => {
    onChooseModel.mockReset();
    useSettingsStore.setState({
      models: MODELS,
      usageBudgets: DEFAULT_USAGE_BUDGETS,
      dailyTokenUsage: { [localDayKey(new Date())]: { [BUCKET_KEY]: BUCKET } },
      usageBudgetAskSnoozedDay: null,
      usageBudgetWarnDismissed: {},
    });
    useBudgetGateStore.setState({ pending: null });
    useUIStore.setState({ isSettingsOpen: false });
  });

  it('renders nothing when no budget is set', () => {
    const { container } = render(
      <BudgetNotice onChooseModel={onChooseModel} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing below the warn threshold', () => {
    setEmissionsAt(70);
    const { container } = render(
      <BudgetNotice onChooseModel={onChooseModel} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the warning from the warn threshold and opens the budget from it', () => {
    setEmissionsAt(82);
    render(<BudgetNotice onChooseModel={onChooseModel} />);
    expect(screen.getByTestId('budget-notice-warn')).toBeInTheDocument();

    fireEvent.click(screen.getByText('usageBudgets.actions.viewBudget'));
    expect(useUIStore.getState()).toMatchObject({
      isSettingsOpen: true,
      settingsInitialSection: SettingsSection.USAGE_IMPACT,
    });
  });

  it('stays dismissed for the rest of the period, and returns in the next one', () => {
    setEmissionsAt(82);
    const { rerender } = render(<BudgetNotice onChooseModel={onChooseModel} />);
    fireEvent.click(screen.getByLabelText('usageBudgets.actions.dismiss'));
    expect(screen.queryByTestId('budget-notice-warn')).not.toBeInTheDocument();
    expect(useSettingsStore.getState().usageBudgetWarnDismissed.emissions).toBe(
      localDayKey(periodStart('month', new Date())),
    );

    // A dismissal recorded against an earlier period no longer applies.
    useSettingsStore.setState({
      usageBudgetWarnDismissed: { emissions: '2000-01-01' },
    });
    rerender(<BudgetNotice onChooseModel={onChooseModel} />);
    expect(screen.getByTestId('budget-notice-warn')).toBeInTheDocument();
  });

  it('asks before sending a held message, and sends it on confirmation', () => {
    setEmissionsAt(101);
    const send = vi.fn();
    useBudgetGateStore.setState({ pending: { kind: 'message', run: send } });
    render(<BudgetNotice onChooseModel={onChooseModel} />);
    expect(screen.getByTestId('budget-notice-ask')).toBeInTheDocument();

    fireEvent.click(screen.getByText('usageBudgets.actions.sendAnyway'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(useBudgetGateStore.getState().pending).toBeNull();
    // Not ticked, so the next message is asked about again.
    expect(useSettingsStore.getState().usageBudgetAskSnoozedDay).toBeNull();
  });

  it('snoozes the question for today only when the box is ticked', () => {
    setEmissionsAt(101);
    const send = vi.fn();
    useBudgetGateStore.setState({ pending: { kind: 'message', run: send } });
    render(<BudgetNotice onChooseModel={onChooseModel} />);

    fireEvent.click(screen.getByLabelText('usageBudgets.actions.dontAskToday'));
    fireEvent.click(screen.getByText('usageBudgets.actions.sendAnyway'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().usageBudgetAskSnoozedDay).toBe(
      localDayKey(new Date()),
    );
  });

  it('drops the held message on "Don\'t send"', () => {
    setEmissionsAt(101);
    const send = vi.fn();
    useBudgetGateStore.setState({ pending: { kind: 'message', run: send } });
    render(<BudgetNotice onChooseModel={onChooseModel} />);

    fireEvent.click(screen.getByText('usageBudgets.actions.dontSend'));
    expect(send).not.toHaveBeenCalled();
    expect(useBudgetGateStore.getState().pending).toBeNull();
  });

  it('drops the held message and opens the model picker on "choose another model"', () => {
    setEmissionsAt(101);
    const send = vi.fn();
    useBudgetGateStore.setState({ pending: { kind: 'message', run: send } });
    render(<BudgetNotice onChooseModel={onChooseModel} />);

    fireEvent.click(screen.getByText('limitsUx.denial.chooseAnotherModel'));
    expect(send).not.toHaveBeenCalled();
    expect(onChooseModel).toHaveBeenCalledTimes(1);
    expect(useBudgetGateStore.getState().pending).toBeNull();
  });

  it('leaves a held workflow run to the run dialog', () => {
    setEmissionsAt(101);
    useBudgetGateStore.setState({ pending: { kind: 'run', run: vi.fn() } });
    render(<BudgetNotice onChooseModel={onChooseModel} />);
    expect(screen.queryByTestId('budget-notice-ask')).not.toBeInTheDocument();
  });

  it('offers only the budget settings once sending is stopped', () => {
    setEmissionsAt(130);
    // A held send must not turn a refusal back into a question.
    useBudgetGateStore.setState({
      pending: { kind: 'message', run: vi.fn() },
    });
    render(<BudgetNotice onChooseModel={onChooseModel} />);
    expect(screen.getByTestId('budget-notice-stop')).toBeInTheDocument();
    expect(
      screen.queryByText('usageBudgets.actions.sendAnyway'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('usageBudgets.actions.openSettings'));
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
  });
});
