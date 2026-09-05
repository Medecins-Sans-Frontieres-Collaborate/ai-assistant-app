import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import type { LimitEntry } from '@/lib/services/limits/types';

import { OpenAIModel, OpenAIModels } from '@/types/openai';

import { CostCalculator } from '@/components/Limits/CostCalculator';
import { LimitsCostProvider } from '@/components/Limits/LimitsCostContext';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The estimator surface (docs/LIMITS_COST_INSIGHTS_DESIGN.md §4c): a
 * per-model table with flag chips, totals and a breakdown, the disclosure
 * line, and a cross-check card against the DRAFT's caps that says "within
 * caps" or names the binding cell and the capped ceiling; the deployment
 * selector is greyed with "n/a" when the mix is all Marketplace/legacy;
 * excluded models show their reason and mark the result incomplete; bad
 * input lists issues instead of numbers; mix presets come from the same
 * family/model catalog as the qualifier picker. Copy is asserted by key
 * (the per-file next-intl mock echoes keys).
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const TERRA = 'gpt-5.6-terra';
const CLAUDE = 'claude-sonnet-4-6';

function model(partial: Partial<OpenAIModel> & { id: string }): OpenAIModel {
  return {
    name: partial.id,
    maxLength: 0,
    tokenLimit: 0,
    ...partial,
  } as OpenAIModel;
}

/** A ring serving gpt-5.4 (the default), the gpt-56 trio, one Claude, one byom. */
const RING: OpenAIModel[] = [
  OpenAIModels['gpt-5.4'],
  OpenAIModels[TERRA],
  OpenAIModels['gpt-5.6-sol'],
  OpenAIModels['gpt-5.6-luna'],
  OpenAIModels[CLAUDE],
  model({
    id: 'byom-abc-terra',
    name: 'My own terra',
    isCustomSourceModel: true,
  }),
];

function renderCalculator(
  caps: LimitEntry[] = [],
  mode: 'global' | 'scoped' = 'global',
) {
  return render(
    <LimitsCostProvider>
      <CostCalculator caps={caps} mode={mode} />
    </LimitsCostProvider>,
  );
}

const entry = (
  partial: Partial<LimitEntry> & { limitKey: string },
): LimitEntry => ({ value: null, ceiling: false, ...partial }) as LimitEntry;

function setField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function pickerSelect(): HTMLSelectElement {
  return screen.getByLabelText('cost.calculator.addModel');
}

beforeEach(() => {
  mockFlags.limitsCostInsights = true;
  mockFlags.limitsCostCalculator = true;
  useSettingsStore.setState({ models: RING });
});

describe('CostCalculator', () => {
  it('renders the default model row, totals, breakdown and the disclosure line', () => {
    renderCalculator();
    const table = screen.getByTestId('cost-per-model');
    expect(within(table).getByText('GPT-5.4')).toBeInTheDocument();
    expect(screen.getByTestId('cost-totals')).toHaveTextContent(
      'cost.calculator.annualized',
    );
    expect(screen.getByText('cost.calculator.breakdown')).toBeInTheDocument();
    expect(screen.getByTestId('cost-disclosure')).toHaveTextContent(
      'cost.calculator.disclosure',
    );
    // Global mode: the cross-check is draft-based and says so.
    expect(
      screen.getAllByText('cost.calculator.draftNote').length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText('cost.calculator.scopedNote'),
    ).not.toBeInTheDocument();
  });

  it('shows a dollar figure per row and never $0 for a priced model', () => {
    renderCalculator();
    const table = screen.getByTestId('cost-per-model');
    const cells = within(table).getAllByRole('cell');
    // Per-request for gpt-5.4 typical (2.5/15): 0.0025 + 0.0075 = $0.01.
    expect(cells.map((c) => c.textContent)).toContain('$0.01');
    expect(cells.some((c) => c.textContent === '$0.00')).toBe(false);
  });

  it('says no cap applies when the draft has no numeric cap', () => {
    renderCalculator();
    expect(screen.getByTestId('cost-verdict-unbounded')).toHaveTextContent(
      'cost.calculator.withinCapsUnbounded',
    );
  });

  it('names the binding cell and the capped ceiling when the entered load exceeds a cap', () => {
    renderCalculator([entry({ limitKey: 'chat.messagesPerDay', value: 10 })]);
    // Defaults are 100 users × 20 requests per day — over the 10/day cap.
    const verdict = screen.getByTestId('cost-verdict-binding');
    expect(verdict).toHaveTextContent('cost.calculator.capBinds');
    const card = screen.getByTestId('cost-cross-check');
    expect(card).toHaveTextContent('cost.calculator.cappedSpend');
    expect(card).toHaveTextContent('chat.messagesPerDay');
    expect(card).toHaveTextContent('cost.calculator.capsConsidered');
  });

  it('is "within caps" when the entered load fits under a cap that still shapes the ceiling', () => {
    renderCalculator([entry({ limitKey: 'chat.messagesPerDay', value: 30 })]);
    expect(screen.getByTestId('cost-verdict-within')).toHaveTextContent(
      'cost.calculator.withinCaps',
    );
    expect(screen.getByTestId('cost-cross-check')).toHaveTextContent(
      'cost.calculator.cappedSpend',
    );
  });

  it('scoped mode says the check covers only the admin’s own overrides', () => {
    renderCalculator([], 'scoped');
    expect(
      screen.getAllByText('cost.calculator.scopedNote').length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText('cost.calculator.draftNote'),
    ).not.toBeInTheDocument();
  });

  it('greys the deployment selector with n/a when the mix is all Marketplace/legacy', () => {
    renderCalculator();
    const deployment = screen.getByLabelText('cost.calculator.deployment');
    expect(deployment).not.toBeDisabled();
    expect(
      screen.queryByText('cost.calculator.deploymentNa'),
    ).not.toBeInTheDocument();

    // Family preset: Claude replaces the mix with its (one) member.
    fireEvent.change(pickerSelect(), { target: { value: 'family:claude' } });
    expect(deployment).toBeDisabled();
    expect(
      screen.getByText('cost.calculator.deploymentNa'),
    ).toBeInTheDocument();
    // At Global (×1) nothing was forced, so no "multiplier n/a" chip either.
    expect(
      screen.queryByText('cost.calculator.chips.multiplierNa'),
    ).not.toBeInTheDocument();
  });

  it('a greyed selector never leaves "multiplier n/a" chips behind a non-Global choice', () => {
    renderCalculator();
    setField('cost.calculator.deployment', 'dataZone');
    // Azure-billed mix at Data Zone: nothing is forced, so no chip.
    expect(
      screen.queryByText('cost.calculator.chips.multiplierNa'),
    ).not.toBeInTheDocument();

    fireEvent.change(pickerSelect(), { target: { value: 'family:claude' } });
    const deployment = screen.getByLabelText(
      'cost.calculator.deployment',
    ) as HTMLSelectElement;
    expect(deployment).toBeDisabled();
    // The choice is kept on the control for when an Azure model rejoins…
    expect(deployment.value).toBe('dataZone');
    // …but the estimate runs at Global, so the rows carry no contradiction.
    expect(
      screen.queryByText('cost.calculator.chips.multiplierNa'),
    ).not.toBeInTheDocument();
  });

  it('labels boolean cells in "caps considered" as allowed/blocked, never unlimited', () => {
    const lineFor = (cell: string) => {
      const card = screen.getByTestId('cost-cross-check');
      const line = within(card)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.startsWith(cell));
      if (!line) throw new Error(`no caps-considered line for ${cell}`);
      return line.textContent ?? '';
    };
    const { unmount } = renderCalculator();
    expect(lineFor('model:gpt-5.4.allowed')).toContain('modeAllowed');
    expect(lineFor('model:gpt-5.4.allowed')).not.toContain('cellUnlimited');
    expect(lineFor('family:gpt.allowed')).toContain('modeAllowed');
    unmount();

    renderCalculator([
      entry({ limitKey: 'model.allowed', modelId: 'gpt-5.4', value: false }),
    ]);
    expect(lineFor('model:gpt-5.4.allowed')).toContain('modeBlocked');
    expect(lineFor('model:gpt-5.4.allowed')).not.toContain('cellBlocked');
  });

  it('a family preset replaces the mix with equal shares over its members', () => {
    renderCalculator();
    fireEvent.change(pickerSelect(), { target: { value: 'family:gpt-56' } });
    const shares = screen.getAllByLabelText(
      'cost.calculator.shareOf',
    ) as HTMLInputElement[];
    expect(shares).toHaveLength(3);
    expect(shares.every((s) => s.value === '33.33')).toBe(true);
    const table = screen.getByTestId('cost-per-model');
    expect(within(table).getByText('GPT-5.6 Terra')).toBeInTheDocument();
    expect(within(table).queryByText('GPT-5.4')).not.toBeInTheDocument();
  });

  it('the default-model preset restores a single default row', () => {
    renderCalculator();
    fireEvent.change(pickerSelect(), { target: { value: 'family:gpt-56' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'cost.calculator.presetDefault' }),
    );
    expect(screen.getAllByLabelText('cost.calculator.shareOf')).toHaveLength(1);
    expect(
      within(screen.getByTestId('cost-per-model')).getByText('GPT-5.4'),
    ).toBeInTheDocument();
  });

  it('hides byom models from the picker until opted in, then prices them as excluded + incomplete', () => {
    renderCalculator();
    expect(
      within(pickerSelect()).queryByRole('option', { name: 'My own terra' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/cost\.calculator\.includeByom/));
    const option = within(pickerSelect()).getByRole('option', {
      name: 'My own terra',
    });
    expect(option).toBeInTheDocument();
    fireEvent.change(pickerSelect(), {
      target: { value: 'model:byom-abc-terra' },
    });

    const table = screen.getByTestId('cost-per-model');
    expect(
      within(table).getByText('cost.calculator.chips.excluded'),
    ).toBeInTheDocument();
    expect(
      within(table).getByText('cost.calculator.noPrice'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'cost.calculator.incomplete',
    );

    // Opting out again drops the row from the estimate and says so.
    fireEvent.click(screen.getByLabelText(/cost\.calculator\.includeByom/));
    expect(screen.getByText('cost.calculator.droppedRows')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('lists input issues instead of numbers, and recovers', () => {
    renderCalculator();
    setField('cost.calculator.users', '-1');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('cost.calculator.issues.users');
    expect(screen.queryByTestId('cost-per-model')).not.toBeInTheDocument();

    setField('cost.calculator.users', '10');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('cost-per-model')).toBeInTheDocument();
  });

  it('a custom profile exposes token fields and rejects an all-zero request', () => {
    renderCalculator();
    expect(
      screen.queryByLabelText('cost.calculator.promptTokens'),
    ).not.toBeInTheDocument();
    setField('cost.calculator.profile', 'custom');
    setField('cost.calculator.promptTokens', '0');
    setField('cost.calculator.completionTokens', '0');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'cost.calculator.issues.tokens',
    );
  });

  it('flags a model the ring does not serve', () => {
    useSettingsStore.setState({ models: [OpenAIModels[CLAUDE]] });
    renderCalculator();
    // Default model resolution falls outside the served list (only Claude
    // is served) — the row is priced from the static registry and flagged.
    expect(
      screen.getByText('cost.calculator.chips.notServed'),
    ).toBeInTheDocument();
  });
});
