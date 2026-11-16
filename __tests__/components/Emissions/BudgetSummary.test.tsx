import { render, screen } from '@testing-library/react';

import { co2eMassParts } from '@/lib/utils/shared/emissions';
import {
  DEFAULT_USAGE_BUDGETS,
  UsageBudget,
  budgetLimit,
  localDayKey,
} from '@/lib/utils/shared/usageBudgets';
import { sumUsageImpact } from '@/lib/utils/shared/usageImpact';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { BudgetSummary } from '@/components/Emissions/BudgetSummary';

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

const enableEmissions = (change: Partial<UsageBudget>) =>
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

const emissionsLimit = (): number =>
  budgetLimit(useSettingsStore.getState().usageBudgets.emissions);

describe('BudgetSummary', () => {
  beforeEach(() => {
    delete mockFlags.showUsageImpact;
    delete mockFlags.showUsageCost;
    useSettingsStore.setState({
      models: MODELS,
      usageBudgets: DEFAULT_USAGE_BUDGETS,
      dailyTokenUsage: { [localDayKey(new Date())]: { [BUCKET_KEY]: BUCKET } },
    });
  });

  it('renders nothing when no budget is switched on', () => {
    const { container } = render(<BudgetSummary />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reports an activity-based budget in CO2e, not in the activity', () => {
    enableEmissions({ amount: 5, unit: 'netflixHd' });
    render(<BudgetSummary />);
    const used = co2eMassParts(USED_GRAMS);
    const limit = co2eMassParts(emissionsLimit());
    expect(used.unit).toBe('grams');
    expect(limit.unit).toBe('grams');

    expect(screen.getByTestId('budget-summary')).toHaveTextContent(
      `${used.value} g CO2e of ${limit.value} g CO2e`,
    );
  });

  it('reads the same whichever unit the budget was set in', () => {
    enableEmissions({ amount: 5, unit: 'netflixHd' });
    const grams = emissionsLimit();
    const { unmount } = render(<BudgetSummary />);
    const byActivity = screen.getByTestId('budget-summary').textContent;
    unmount();

    enableEmissions({ amount: grams, unit: 'grams' });
    render(<BudgetSummary />);
    expect(screen.getByTestId('budget-summary').textContent).toBe(byActivity);
  });

  it('scales a large budget to kilograms', () => {
    enableEmissions({ amount: 500, unit: 'netflixHd' });
    render(<BudgetSummary />);
    const limit = co2eMassParts(emissionsLimit());
    expect(limit.unit).toBe('kilograms');
    expect(screen.getByTestId('budget-summary')).toHaveTextContent(
      `of ${limit.value} kg CO2e`,
    );
  });
});
