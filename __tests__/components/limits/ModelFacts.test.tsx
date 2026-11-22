import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { NextIntlClientProvider } from 'next-intl';

import type { ModelAccessRule } from '@/lib/services/limits/types';
import type {
  ModelUsageInsight,
  UsageInsights,
} from '@/lib/services/limits/wire';

import { DAYS_PER_MONTH } from '@/lib/utils/app/modelFacts';

import type { OpenAIModel } from '@/types/openai';

import { ModelAccessTab } from '@/components/Limits/ModelAccessTab';

import { useSettingsStore } from '@/client/stores/settingsStore';
import messages from '@/messages/en.json';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real English messages: a missing key or bad ICU throws.
vi.unmock('next-intl');
// Every flag off: list prices and cost estimates are shown regardless.
vi.mock('launchdarkly-react-client-sdk', () => ({ useFlags: () => ({}) }));
vi.mock('@/client/hooks/useM365PeopleSuggest', () => ({
  useM365PeopleSuggest: () => undefined,
}));
vi.mock('@/client/services/m365/m365Client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lookupEntraGroups: vi.fn().mockResolvedValue([]),
  searchEntraGroups: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/client/hooks/useAgentAccessGroupsEnabled', () => ({
  useAgentAccessGroupsEnabled: () => true,
}));

const DAY_MS = 86_400_000;
/** $2 in, $10 out per 1M: a typical request (1,000 in, 500 out) is $0.007. */
const TYPICAL_USD = 0.007;

/** Retires in 21 days (inside the notice window), replaced by Test New. */
const OLD = {
  id: 'test-old',
  name: 'Test Old',
  maxLength: 128000,
  tokenLimit: 16000,
  modelType: 'omni',
  sizeClass: 'large',
  pricing: { inputPer1M: 2, outputPer1M: 10 },
  retiresAt: new Date(Date.now() + 21 * DAY_MS).toISOString(),
  retirementReplacement: 'test-new',
} as unknown as OpenAIModel;
/** No size class, no retirement date. */
const NEW = {
  id: 'test-new',
  name: 'Test New',
  maxLength: 200000,
  tokenLimit: 16000,
  modelType: 'omni',
  pricing: { inputPer1M: 2, outputPer1M: 10 },
} as unknown as OpenAIModel;

/** Its retirement date passed 30 days ago. */
const GONE = {
  id: 'test-gone',
  name: 'Test Gone',
  maxLength: 8000,
  tokenLimit: 4000,
  modelType: 'omni',
  pricing: { inputPer1M: 1, outputPer1M: 2 },
  retiresAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
} as unknown as OpenAIModel;

function usage(modelId: string, peaks: number[]): ModelUsageInsight {
  const requests = peaks.reduce((sum, value) => sum + value, 0);
  return {
    modelId,
    people: peaks.length,
    peopleAreLowerBound: false,
    requests,
    calls: requests,
    promptTokens: 0,
    completionTokens: 0,
    activePersonDays: peaks.length,
    peaks,
    peaksTruncated: false,
    daily: [],
  };
}

/** Test Old: 6 people, busiest days from 4 to 100. Test New: unused. */
const INSIGHTS: UsageInsights = {
  status: 'ready',
  latestDay: '2026-11-20',
  days: ['2026-11-19', '2026-11-20'],
  partial: false,
  cells: {},
  models: { 'test-old': usage('test-old', [4, 9, 29, 30, 31, 100]) },
  modelDays: ['2026-11-19', '2026-11-20'],
};

function rule(partial: Partial<ModelAccessRule>): ModelAccessRule {
  return { groups: [], domains: [], allow: [], deny: [], ...partial };
}
/** Test Old is capped at 30 a day for everyone else; Test New is not. */
const RULES = [rule({ modelId: 'test-old', defaultAccess: 30 })];

function renderTab(
  options: { rules?: ModelAccessRule[]; insights?: UsageInsights } = {},
) {
  const onChange = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        onError={(error) => {
          throw error;
        }}
      >
        <ModelAccessTab
          rules={options.rules ?? RULES}
          defaults={[]}
          onChange={onChange}
          mode="enforce"
          insights={'insights' in options ? options.insights : INSIGHTS}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return onChange;
}

const rowOf = (label: string): HTMLElement =>
  screen
    .getAllByRole('rowheader')
    .find((header) => header.textContent?.startsWith(label))
    ?.closest('tr') as HTMLElement;
/** The button on a row's name that opens its editor (cells are pressed, not expanded). */
const rowButton = (label: string): HTMLElement =>
  screen.getByRole('button', {
    name: new RegExp(`^${label}, `),
    expanded: false,
  });
const usd = (value: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(
    value,
  );

beforeEach(() => {
  useSettingsStore.setState({ models: [OLD, NEW, GONE] });
});

describe('Models grid facts', () => {
  it('shows footprint, usage and retirement beside the access rules', () => {
    renderTab();
    const old = within(rowOf('Test Old'));
    expect(old.getByText('Large')).toBeInTheDocument();
    expect(old.getByText('6')).toBeInTheDocument();
    expect(old.getByText('median 29, 75th 31, most 100')).toBeInTheDocument();
    expect(
      old.getByRole('img', { name: /median 29.*The cap is 30 a day/ }),
    ).toBeInTheDocument();
    expect(old.getByText('in 21 days, to Test New')).toBeInTheDocument();

    // Unused, no size class, no date: each says so rather than showing 0.
    const unused = within(rowOf('Test New'));
    expect(unused.getByText('Size not set')).toBeInTheDocument();
    expect(unused.getAllByText('No usage').length).toBeGreaterThan(0);
    expect(unused.getByText('No date published')).toBeInTheDocument();
  });

  it('turns a cap into the most one person can cost, and says when there is no ceiling', () => {
    renderTab();
    expect(
      screen.getByRole('columnheader', { name: 'List price per 1M tokens' }),
    ).toBeInTheDocument();
    const old = within(rowOf('Test Old'));
    expect(old.getByText('$2 in, $10 out')).toBeInTheDocument();
    expect(
      old.getByText(usd(30 * TYPICAL_USD * DAYS_PER_MONTH)),
    ).toBeInTheDocument();
    expect(
      within(rowOf('Test New')).getByText('No ceiling'),
    ).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'Cost and CO2e are estimates, not measured spend: counted requests multiplied by a typical request (1000 tokens in, 500 out) at list price.',
    );
    // 203 requests at $0.007.
    const summary = screen.getByLabelText('Models at a glance');
    expect(
      within(summary).getByText(usd(203 * TYPICAL_USD)),
    ).toBeInTheDocument();
    expect(within(summary).getByText(/^1 of \d+$/)).toBeInTheDocument();
  });

  it('hides and shows a group of columns', () => {
    renderTab();
    const toggle = screen.getByRole('button', { name: 'Usage' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.queryByRole('columnheader', { name: 'People using it' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Retires' }),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(
      screen.getByRole('columnheader', { name: 'People using it' }),
    ).toBeInTheDocument();
  });

  it('says usage is not collected yet instead of showing zeroes', () => {
    renderTab({ insights: { ...INSIGHTS, models: {}, modelDays: [] } });
    expect(screen.getByRole('note')).toHaveTextContent(
      'Usage by everyone appears after the first full day of collection.',
    );
    const summary = screen.getByLabelText('Models at a glance');
    expect(within(summary).getAllByText('Not yet known').length).toBe(3);
  });

  it('renders with no insights at all', () => {
    renderTab({ insights: undefined });
    expect(within(rowOf('Test Old')).getAllByText('No usage').length).toBe(2);
  });
});

describe('Retired models', () => {
  const toggle = () =>
    screen.getByRole('button', { name: /^Retired models \(\d+\)$/ });

  it('are left out of the grid until asked for, and one retiring soon is not', () => {
    renderTab();
    expect(rowOf('Test Gone')).toBeUndefined();
    expect(rowOf('Test Old')).toBeDefined();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(rowOf('Test Gone')).getByText('date has passed'),
    ).toBeInTheDocument();

    fireEvent.click(toggle());
    expect(rowOf('Test Gone')).toBeUndefined();
  });

  it('leave the count of models in the strip while hidden', () => {
    renderTab();
    const summary = within(screen.getByLabelText('Models at a glance'));
    const total = () =>
      Number(summary.getByText(/^1 of \d+$/).textContent?.split(' of ')[1]);
    const hidden = total();
    fireEvent.click(toggle());
    expect(total()).toBeGreaterThan(hidden);
  });

  it('are shown when opened from the runway', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Retirement runway' }));
    expect(
      screen.getByText('Past its date and still listed:').parentElement,
    ).toHaveTextContent('Test Gone');
  });
});

describe('Open row context', () => {
  const open = () => {
    fireEvent.click(rowButton('Test Old'));
    return within(
      screen.getByRole('region', {
        name: 'How this model is used, and what it costs',
      }),
    );
  };

  it('shows the distribution and what each cap would have done', () => {
    renderTab();
    const context = open();
    expect(
      context.getByText(/6 people used it in the last 2 days/),
    ).toBeInTheDocument();
    const stat = (label: string) =>
      context.getByText(label).nextElementSibling?.textContent;
    expect(stat('Median')).toBe('29');
    expect(stat('75th percentile')).toBe('31');
    expect(stat('Heaviest person')).toBe('100');

    // The current cap of 30: the people at 30, 31 and 100 would be stopped.
    const now = context.getByRole('rowheader', { name: '30 a day (now)' });
    const cells = within(now.closest('tr') as HTMLElement).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('3 (50%)');
    expect(cells[1]).toHaveTextContent(usd(30 * TYPICAL_USD * DAYS_PER_MONTH));
    expect(context.getByText('Estimated cost')).toBeInTheDocument();
    expect(context.getByText('128,000 tokens')).toBeInTheDocument();
  });

  it('says so when nobody used the model, and offers no replay', () => {
    renderTab();
    fireEvent.click(rowButton('Test New'));
    const context = within(
      screen.getByRole('region', {
        name: 'How this model is used, and what it costs',
      }),
    );
    expect(
      context.getByText('Nobody used this model in the last 2 days.'),
    ).toBeInTheDocument();
    expect(
      context.queryByText('If the cap were different'),
    ).not.toBeInTheDocument();
    expect(context.getByText(/has no size class/)).toBeInTheDocument();
  });

  it('gives a family row no facts of its own', () => {
    renderTab();
    fireEvent.click(rowButton('Claude'));
    expect(
      screen.queryByRole('region', {
        name: 'How this model is used, and what it costs',
      }),
    ).not.toBeInTheDocument();
  });
});

describe('Retirement runway', () => {
  const show = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Retirement runway' }));

  it('lists a retiring model with its replacement and the rule difference', () => {
    renderTab();
    show();
    expect(screen.getByText(/Test Old retires in 21 days/)).toHaveTextContent(
      '6 people used it recently. They will be moved to Test New.',
    );
    const row = within(
      screen
        .getByRole('rowheader', { name: /^Test Old/ })
        .closest('tr') as HTMLElement,
    );
    expect(
      row.getByText('Everyone else gets different terms'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No date published:').parentElement,
    ).toHaveTextContent('Test New');
  });

  it('copies the rules to the replacement as a draft', () => {
    const onChange = renderTab();
    show();
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy these rules to Test New' }),
    );
    expect(onChange).toHaveBeenCalledWith([
      RULES[0],
      rule({ modelId: 'test-new', defaultAccess: 30 }),
    ]);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Copied the rules of Test Old to Test New. Review and save to apply.',
    );
  });

  it('reports matching rules, and offers nothing to copy', () => {
    renderTab({
      rules: [...RULES, rule({ modelId: 'test-new', defaultAccess: 30 })],
    });
    show();
    const row = within(
      screen
        .getByRole('rowheader', { name: /^Test Old/ })
        .closest('tr') as HTMLElement,
    );
    expect(row.getByText('Same rules')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Copy these rules/ }),
    ).not.toBeInTheDocument();
  });

  it('opens a model in the grid from the runway', () => {
    renderTab();
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Test Old' }));
    expect(
      screen.getByRole('region', { name: 'Who can use Test Old' }),
    ).toBeInTheDocument();
  });

  it('does not leave the grid while the editor holds entries nobody added', () => {
    renderTab();
    fireEvent.click(rowButton('Test Old'));
    const editor = screen.getByRole('region', { name: 'Who can use Test Old' });
    const field = within(editor).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'oca.msf.org' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    show();
    expect(within(editor).getByRole('alert')).toHaveTextContent(
      '1 entry in the field is not added yet.',
    );
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Close without adding' }),
    );
    expect(screen.getByText(/Test Old retires in 21 days/)).toBeInTheDocument();
  });
});

describe('Spend and popularity map', () => {
  it('plots used, priced models and points out what stands out', () => {
    renderTab({
      insights: {
        ...INSIGHTS,
        models: {
          ...INSIGHTS.models,
          'test-new': usage('test-new', [2, 300]),
        },
        cells: {
          'model.requests|model:test-old': {
            limitKey: 'model.requests',
            modelId: 'test-old',
            yesterday: {
              people: 6,
              bands: { underHalf: 2, toEighty: 0, nearCap: 1, atCap: 3 },
              withoutCap: 0,
            },
            byRule: {},
            events: 5,
            eventPeople: 3,
            blocked: 7,
            peaks: [4, 9, 29, 30, 31, 100],
            peaksTruncated: false,
          },
        },
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Spend and popularity' }),
    );
    expect(
      screen.getByRole('button', { name: /^Test Old: 6 people, / }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Test Old: 3 of 6 people reached 30 a day.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Test New: unlimited for everyone else. The heaviest person made 300 requests in a day.',
      ),
    ).toBeInTheDocument();
    // 302 of 505 requests at the same price.
    expect(
      screen.getByText('Test New is 59.8% of estimated spend.'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /^Test New: 2 people/ }),
    );
    expect(
      screen.getByRole('region', { name: 'Who can use Test New' }),
    ).toBeInTheDocument();
  });

  it('says so when no priced model was used', () => {
    renderTab({ insights: { ...INSIGHTS, models: {} } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Spend and popularity' }),
    );
    expect(
      screen.getByText('No priced model was used in the last 2 days.'),
    ).toBeInTheDocument();
  });
});
