import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { LimitEntry } from '@/lib/services/limits/types';

import { OpenAIModel } from '@/types/openai';

import { GlobalDefaultsSection } from '@/components/Limits/GlobalDefaultsSection';
import { LimitsCostProvider } from '@/components/Limits/LimitsCostContext';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

/** Flags default to none — the OFF path every pre-existing case runs on. */
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

function renderSection(entries: LimitEntry[]) {
  const onChange = vi.fn();
  render(<GlobalDefaultsSection entries={entries} onChange={onChange} />);
  return onChange;
}

/** The section element for a feature group, located by its heading. */
function groupSection(groupKey: string): HTMLElement {
  const heading = screen.getByText(groupKey);
  const section = heading.closest('section');
  if (!section) throw new Error(`no <section> around ${groupKey}`);
  return section;
}

describe('GlobalDefaultsSection', () => {
  it('renders a feature gate and its caps adjacent in one group', () => {
    renderSection([]);

    const section = groupSection('group.codeInterpreter');
    // Gate control in the header + the cap row, together.
    expect(within(section).getAllByLabelText('valueModeLabel')).toHaveLength(2);
    expect(
      within(section).getByText('label.codeInterpreterRunsPerDay'),
    ).toBeInTheDocument();
    // The old category layout is gone.
    expect(screen.queryByText('category.tools')).not.toBeInTheDocument();
  });

  it('dims and disables cap rows when the gate is explicitly blocked', () => {
    renderSection([
      {
        limitKey: 'feature.codeInterpreter.enabled',
        value: false,
        ceiling: false,
      },
      {
        limitKey: 'feature.codeInterpreter.runsPerDay',
        value: 50,
        ceiling: false,
      },
    ]);

    const section = groupSection('group.codeInterpreter');
    const [gateSelect, capSelect] =
      within(section).getAllByLabelText('valueModeLabel');
    // The gate itself stays operable — it is how the admin turns it back on.
    expect(gateSelect).not.toBeDisabled();
    expect(capSelect).toBeDisabled();
    expect(within(section).getByLabelText('valueAmountLabel')).toBeDisabled();
    expect(within(section).getByText('gateOffDimNote')).toBeInTheDocument();
    // Hard-refusal consequence copy renders with the gate decision.
    expect(
      within(section).getByText('gateOffConsequence.codeInterpreter'),
    ).toBeInTheDocument();
  });

  it('does not dim caps when the gate is merely unset (catalog default on)', () => {
    renderSection([
      {
        limitKey: 'feature.codeInterpreter.runsPerDay',
        value: 50,
        ceiling: false,
      },
    ]);

    const section = groupSection('group.codeInterpreter');
    const [, capSelect] = within(section).getAllByLabelText('valueModeLabel');
    expect(capSelect).not.toBeDisabled();
    expect(
      within(section).queryByText('gateOffDimNote'),
    ).not.toBeInTheDocument();
  });

  it('preserves configured cap values when the gate is toggled off (render-only dimming)', () => {
    const onChange = renderSection([
      {
        limitKey: 'feature.codeInterpreter.runsPerDay',
        value: 50,
        ceiling: true,
      },
    ]);

    const section = groupSection('group.codeInterpreter');
    const [gateSelect] = within(section).getAllByLabelText('valueModeLabel');
    fireEvent.change(gateSelect, { target: { value: 'blocked' } });

    expect(onChange).toHaveBeenCalled();
    const next: LimitEntry[] = onChange.mock.calls[0][0];
    expect(
      next.find((e) => e.limitKey === 'feature.codeInterpreter.enabled')?.value,
    ).toBe(false);
    const cap = next.find(
      (e) => e.limitKey === 'feature.codeInterpreter.runsPerDay',
    );
    expect(cap?.value).toBe(50);
    expect(cap?.ceiling).toBe(true);
  });

  it('explains the silent-skip consequence when a cap is blocked but the gate is on', () => {
    renderSection([
      { limitKey: 'feature.webSearch.callsPerDay', value: 0, ceiling: false },
    ]);

    const section = groupSection('group.webSearch');
    expect(
      within(section).getByText('capBlockedConsequence.webSearch'),
    ).toBeInTheDocument();
    // No gate-off copy — the feature is still on.
    expect(
      within(section).queryByText('gateOffConsequence.webSearch'),
    ).not.toBeInTheDocument();
  });

  it('does not gate the Models group off model.allowed (perModel boolean, not a gate)', () => {
    renderSection([
      { limitKey: 'model.allowed', value: false, ceiling: false },
    ]);

    const section = groupSection('group.models');
    expect(
      within(section).queryByText('gateOffDimNote'),
    ).not.toBeInTheDocument();
    for (const select of within(section).getAllByLabelText('valueModeLabel')) {
      expect(select).not.toBeDisabled();
    }
  });
});

/**
 * Cost insights (docs/LIMITS_COST_INSIGHTS_DESIGN.md §4a) on the defaults
 * tab: with the flag undefined nothing cost-related renders anywhere in the
 * section (the OFF path every case above already exercises); with
 * `limitsCostInsights` on and a provider, the hint appears for the keys that
 * price (chat.messagesPerDay, chat.tokensPerDay, model.requests) and NOT for
 * feature counters, booleans, model.allowed, or blocked rows.
 */
describe('GlobalDefaultsSection — cost insights', () => {
  const PRICED = {
    id: 'test-priced',
    name: 'test-priced',
    maxLength: 0,
    tokenLimit: 0,
    isDisabled: false,
    pricing: { inputPer1M: 10, outputPer1M: 20 },
  } as OpenAIModel;

  const ENTRIES: LimitEntry[] = [
    { limitKey: 'chat.messagesPerDay', value: 10, ceiling: false },
    { limitKey: 'chat.tokensPerDay', value: 100_000, ceiling: false },
    { limitKey: 'model.requests', value: 20, ceiling: false },
    { limitKey: 'feature.tts.charactersPerDay', value: 5000, ceiling: false },
    { limitKey: 'feature.webSearch.enabled', value: true, ceiling: false },
    { limitKey: 'chat.tokensPerMonth', value: 0, ceiling: false },
  ];

  beforeEach(() => {
    delete mockFlags.limitsCostInsights;
    useSettingsStore.setState({ models: [PRICED] });
  });

  const hintsIn = (groupKey: string) =>
    within(groupSection(groupKey)).queryAllByTestId('limits-cost-hint');

  it('renders no cost copy when the flag is undefined, provider or not', () => {
    render(
      <LimitsCostProvider>
        <GlobalDefaultsSection entries={ENTRIES} onChange={vi.fn()} />
      </LimitsCostProvider>,
    );
    expect(screen.queryAllByTestId('limits-cost-hint')).toHaveLength(0);
    expect(screen.queryByText(/^cost\./)).not.toBeInTheDocument();
  });

  it('annotates only the rows that price when the flag is on', () => {
    mockFlags.limitsCostInsights = true;
    render(
      <LimitsCostProvider>
        <GlobalDefaultsSection entries={ENTRIES} onChange={vi.fn()} />
      </LimitsCostProvider>,
    );
    // chat: messagesPerDay + tokensPerDay priced; tokensPerMonth blocked → not.
    expect(hintsIn('group.chat').map((el) => el.textContent)).toEqual([
      'cost.upToPriciest',
      'cost.upToTokens',
    ]);
    // models: model.requests priced; model.allowed (unset boolean) → not.
    expect(hintsIn('group.models').map((el) => el.textContent)).toEqual([
      'cost.upToPriciest',
    ]);
    // Feature counters and booleans never price.
    expect(hintsIn('group.readAloud')).toHaveLength(0);
    expect(hintsIn('group.webSearch')).toHaveLength(0);
    expect(screen.getAllByTestId('limits-cost-hint')).toHaveLength(3);
  });

  it('renders nothing for a priced row without a provider', () => {
    mockFlags.limitsCostInsights = true;
    render(<GlobalDefaultsSection entries={ENTRIES} onChange={vi.fn()} />);
    expect(screen.queryAllByTestId('limits-cost-hint')).toHaveLength(0);
  });
});
